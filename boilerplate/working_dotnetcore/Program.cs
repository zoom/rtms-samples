
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using dotenv.net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.DependencyInjection;
using System.Collections.Concurrent;

var builder = WebApplication.CreateBuilder(args);
DotEnv.Load();
var app = builder.Build();

var port = Environment.GetEnvironmentVariable("PORT") ?? "3000";
var webhookPath = Environment.GetEnvironmentVariable("WEBHOOK_PATH") ?? "/webhook";
var zoomSecretToken = Environment.GetEnvironmentVariable("ZOOM_SECRET_TOKEN");
var clientId = Environment.GetEnvironmentVariable("ZOOM_CLIENT_ID");
var clientSecret = Environment.GetEnvironmentVariable("ZOOM_CLIENT_SECRET");
var mediaTypesFlag = ParseMediaTypesFlag(Environment.GetEnvironmentVariable("MEDIA_TYPES_FLAG") ?? "11");
var mediaSocketConnectionMode = ParseMediaSocketConnectionMode(
    Environment.GetEnvironmentVariable("MEDIA_SOCKET_CONNECTION_MODE") ?? "split");

if (mediaSocketConnectionMode == "unified" && mediaTypesFlag != 32)
{
    throw new InvalidOperationException(
        "MEDIA_SOCKET_CONNECTION_MODE=unified requires MEDIA_TYPES_FLAG=32. Use split mode for combined masks such as 11.");
}

Console.WriteLine($"DEBUG - PORT: {port}");
Console.WriteLine($"DEBUG - WEBHOOK_PATH: {webhookPath}");
Console.WriteLine($"DEBUG - MEDIA_TYPES_FLAG: {mediaTypesFlag} ({mediaSocketConnectionMode} mode)");

var activeConnections = new ConcurrentDictionary<string, ConcurrentDictionary<string, ClientWebSocket>>();
var signalingInFlight = new ConcurrentDictionary<string, byte>();
var signalingSendLocks = new ConcurrentDictionary<string, SemaphoreSlim>();

app.MapPost(webhookPath, async (HttpRequest request, HttpResponse response, ILogger<Program> logger) =>
{
    using var reader = new StreamReader(request.Body);
    var bodyStr = await reader.ReadToEndAsync();
    var doc = JsonDocument.Parse(bodyStr);
    var root = doc.RootElement;

    var eventType = root.GetProperty("event").GetString();
    var payload = root.GetProperty("payload");

    if (eventType == "endpoint.url_validation" && payload.TryGetProperty("plainToken", out var plainTokenEl))
    {
        var plainToken = plainTokenEl.GetString();
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(zoomSecretToken));
        var hashBytes = hmac.ComputeHash(Encoding.UTF8.GetBytes(plainToken));
        var encryptedToken = BitConverter.ToString(hashBytes).Replace("-", "").ToLowerInvariant();

        response.ContentType = "application/json";
        await response.WriteAsJsonAsync(new { plainToken, encryptedToken });
        return;
    }

    // Commit Zoom's acknowledgement before starting any RTMS lifecycle work.
    response.StatusCode = StatusCodes.Status200OK;
    await response.CompleteAsync();
    logger.LogInformation("RTMS Webhook acknowledged: {body}", bodyStr);

    if (eventType == "meeting.rtms_started")
    {
        var meetingUuid = payload.GetProperty("meeting_uuid").GetString();
        var streamId = payload.GetProperty("rtms_stream_id").GetString();
        var serverUrl = payload.GetProperty("server_urls").GetString();
        if (string.IsNullOrWhiteSpace(streamId))
        {
            logger.LogWarning("Missing rtms_stream_id in meeting.rtms_started payload");
            return;
        }
        if (activeConnections.TryGetValue(meetingUuid!, out var existingConnDict) &&
            existingConnDict.TryGetValue("signaling", out var existingSignaling) &&
            existingSignaling.State != WebSocketState.Closed &&
            existingSignaling.State != WebSocketState.Aborted)
        {
            logger.LogWarning("Active signaling socket already exists for meeting {meetingUuid} stream {streamId}", meetingUuid, streamId);
            return;
        }
        if (!signalingInFlight.TryAdd(streamId!, 0))
        {
            logger.LogWarning("Duplicate signaling handshake blocked for stream {streamId}", streamId);
            return;
        }
        Console.WriteLine($"DEBUG - Starting signaling WebSocket for meeting {meetingUuid}, stream {streamId}, server: {serverUrl}");
        _ = ConnectToSignalingWebSocket(meetingUuid, streamId, serverUrl, logger);
    }

    if (eventType == "meeting.rtms_stopped")
    {
        var meetingUuid = payload.GetProperty("meeting_uuid").GetString();
        Console.WriteLine($"DEBUG - RTMS stopped event for meeting: {meetingUuid}");
        var streamId = payload.TryGetProperty("rtms_stream_id", out var sidEl) ? sidEl.GetString() : null;
        if (!string.IsNullOrEmpty(streamId))
        {
            signalingInFlight.TryRemove(streamId, out _);
            signalingSendLocks.TryRemove(streamId, out _);
        }
        if (activeConnections.TryRemove(meetingUuid, out var connDict))
        {
            foreach (var conn in connDict.Values)
            {
                if (conn.State == WebSocketState.Open)
                {
                    await conn.CloseAsync(WebSocketCloseStatus.NormalClosure, "RTMS stopped", CancellationToken.None);
                }
            }
        }
    }

});

async Task ConnectToSignalingWebSocket(string meetingUuid, string streamId, string serverUrl, ILogger logger)
{
    var ws = new ClientWebSocket();
    await ws.ConnectAsync(new Uri(serverUrl), CancellationToken.None);

    var meetingConnections = activeConnections.GetOrAdd(
        meetingUuid, _ => new ConcurrentDictionary<string, ClientWebSocket>());
    meetingConnections["signaling"] = ws;

    var signature = GenerateSignature(clientId, meetingUuid, streamId, clientSecret);
    var handshake = new
    {
        msg_type = 1,
        protocol_version = 1,
        meeting_uuid = meetingUuid,
        rtms_stream_id = streamId,
        sequence = new Random().Next(1, int.MaxValue),
        signature,
        buffer_data = false
    };
    var handshakeBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(handshake));
    await ws.SendAsync(new ArraySegment<byte>(handshakeBytes), WebSocketMessageType.Text, true, CancellationToken.None);

    _ = Task.Run(async () =>
    {
        var buffer = new byte[8192];
        while (ws.State == WebSocketState.Open)
        {
            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                break;
            }
            var messageStr = Encoding.UTF8.GetString(buffer, 0, result.Count);
            logger.LogInformation("Signaling Message: {msg}", messageStr);
            Console.WriteLine("DEBUG - Signaling Raw Message: " + messageStr);
            var msg = JsonSerializer.Deserialize<JsonElement>(messageStr);

            var msgType = msg.GetProperty("msg_type").GetInt32();
            switch (msgType)
            {
                case 2 when msg.GetProperty("status_code").GetInt32() == 0:
                    var serverUrls = msg.GetProperty("media_server").GetProperty("server_urls");
                    if (mediaSocketConnectionMode == "unified")
                    {
                        if (!serverUrls.TryGetProperty("all", out var allMediaUrlElement))
                        {
                            logger.LogWarning("No unified media URL returned for stream {streamId}", streamId);
                            break;
                        }

                        await ConnectToMediaWebSocket(
                            allMediaUrlElement.GetString(), meetingUuid, streamId, ws, "all", 32, logger);
                        break;
                    }

                    var requestedFlags = mediaTypesFlag == 32 ? 31 : mediaTypesFlag;
                    var mediaDefinitions = new[]
                    {
                        (Name: "audio", Flag: 1),
                        (Name: "video", Flag: 2),
                        (Name: "deskshare", Flag: 4),
                        (Name: "transcript", Flag: 8),
                        (Name: "chat", Flag: 16)
                    };
                    var mediaConnections = new List<Task>();
                    foreach (var media in mediaDefinitions)
                    {
                        if ((requestedFlags & media.Flag) == 0)
                            continue;

                        if (!serverUrls.TryGetProperty(media.Name, out var mediaUrlElement))
                        {
                            logger.LogWarning("No {mediaName} media URL returned for stream {streamId}", media.Name, streamId);
                            continue;
                        }

                        mediaConnections.Add(ConnectToMediaWebSocket(
                            mediaUrlElement.GetString(), meetingUuid, streamId, ws, media.Name, media.Flag, logger));
                    }
                    await Task.WhenAll(mediaConnections);
                    break;
                case 2:
                    signalingInFlight.TryRemove(streamId, out _);
                    logger.LogWarning("Signaling handshake failed for stream {streamId}: {msg}", streamId, messageStr);
                    break;

                case 12:
                    var timestamp = msg.GetProperty("timestamp").GetInt64();
                    await SendSignalingMessageAsync(ws, streamId, new { msg_type = 13, timestamp });
                    break;
            }
        }
        signalingInFlight.TryRemove(streamId, out _);
    });
}

async Task ConnectToMediaWebSocket(string? mediaUrl, string meetingUuid, string streamId, ClientWebSocket signalingSocket, string mediaName, int mediaType, ILogger logger)
{
    if (string.IsNullOrWhiteSpace(mediaUrl))
    {
        logger.LogWarning("No {mediaName} media URL returned for stream {streamId}", mediaName, streamId);
        return;
    }

    var ws = new ClientWebSocket();
    await ws.ConnectAsync(new Uri(mediaUrl), CancellationToken.None);

    var meetingConnections = activeConnections.GetOrAdd(
        meetingUuid, _ => new ConcurrentDictionary<string, ClientWebSocket>());
    meetingConnections[mediaName] = ws;

    var signature = GenerateSignature(clientId, meetingUuid, streamId, clientSecret);
    object mediaParams = mediaName switch
    {
        "audio" => new { audio = new { content_type = 2, sample_rate = 1, channel = 1, codec = 1, data_opt = 1, send_rate = 100 } },
        "video" => new { video = new { content_type = 3, codec = 7, resolution = 2, fps = 25, data_opt = 3 } },
        "deskshare" => new { deskshare = new { content_type = 3, codec = 5, resolution = 2, fps = 1 } },
        "transcript" => new { transcript = new { content_type = 5, src_language = 9, enable_lid = true } },
        "chat" => new { chat = new { content_type = 5 } },
        "all" => new
        {
            audio = new { content_type = 2, sample_rate = 1, channel = 1, codec = 1, data_opt = 1, send_rate = 100 },
            video = new { content_type = 3, codec = 7, resolution = 2, fps = 25, data_opt = 3 },
            deskshare = new { content_type = 3, codec = 5, resolution = 2, fps = 1 },
            transcript = new { content_type = 5, src_language = 9, enable_lid = true },
            chat = new { content_type = 5 }
        },
        _ => throw new ArgumentOutOfRangeException(nameof(mediaName), mediaName, "Unsupported media type")
    };
    var handshake = new
    {
        msg_type = 3,
        protocol_version = 1,
        meeting_uuid = meetingUuid,
        rtms_stream_id = streamId,
        signature,
        media_type = mediaType,
        payload_encryption = false,
        media_params = mediaParams
    };
    Console.WriteLine($"DEBUG - Sending {mediaName} media handshake: {JsonSerializer.Serialize(handshake)}");
    var handshakeBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(handshake));
    await ws.SendAsync(new ArraySegment<byte>(handshakeBytes), WebSocketMessageType.Text, true, CancellationToken.None);
_ = Task.Run(async () =>
{
    var buffer = new byte[8192];
    try
    {
        while (ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"WebSocket receive error: {ex.Message}");
                break;
            }

            if (result.MessageType == WebSocketMessageType.Close)
            {
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                break;
            }

            var messageStr = Encoding.UTF8.GetString(buffer, 0, result.Count);
            Console.WriteLine("Received message: " + messageStr);

            try
            {
                var msg = JsonSerializer.Deserialize<JsonElement>(messageStr);
                var msgType = msg.GetProperty("msg_type").GetInt32();

                switch (msgType)
                {
                    case 4 when msg.GetProperty("status_code").GetInt32() == 0:
                        var readyAck = new { msg_type = 7, rtms_stream_id = streamId };
                        await SendSignalingMessageAsync(signalingSocket, streamId, readyAck);
                        Console.WriteLine($"DEBUG - {mediaName} handshake succeeded; CLIENT_READY_ACK sent");
                        break;

                    case 4:
                        Console.WriteLine($"{mediaName} media handshake failed: {messageStr}");
                        break;

                    case 12:
                        var timestamp = msg.GetProperty("timestamp").GetInt64();
                        var keepAlive = new { msg_type = 13, timestamp };
                        await ws.SendAsync(
                            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(keepAlive)),
                            WebSocketMessageType.Text, true, CancellationToken.None);
                        break;

                    case 14:
                        Console.WriteLine("DEBUG - Audio data received");
                        break;

                    case 15:
                        Console.WriteLine("DEBUG - Video data received");
                        break;

                    case 16:
                        Console.WriteLine("DEBUG - Screen share data received");
                        break;

                    case 17:
                        Console.WriteLine("DEBUG - Transcript data received");
                        break;

                    case 18:
                        Console.WriteLine("DEBUG - Chat data received");
                        break;

                    default:
                        Console.WriteLine($"Unhandled message type: {msgType}");
                        break;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error processing message: {ex.Message}");
                Console.WriteLine("Raw message: " + messageStr);
            }
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Unexpected error in WebSocket loop: {ex}");
    }
});
}

int ParseMediaTypesFlag(string rawValue)
{
    const int allIndividualMediaFlags = 1 | 2 | 4 | 8 | 16;
    if (!int.TryParse(rawValue.Trim(), out var parsedValue) ||
        (parsedValue != 32 && (parsedValue <= 0 || (parsedValue & ~allIndividualMediaFlags) != 0)))
    {
        throw new InvalidOperationException(
            $"Unsupported MEDIA_TYPES_FLAG: {rawValue}. Combine audio (1), video (2), screen share (4), transcript (8), and chat (16), or use 32 for all.");
    }

    return parsedValue;
}

string ParseMediaSocketConnectionMode(string rawValue)
{
    var normalizedValue = rawValue.Trim().ToLowerInvariant();
    if (normalizedValue is not ("split" or "unified"))
    {
        throw new InvalidOperationException(
            $"Unsupported MEDIA_SOCKET_CONNECTION_MODE: {rawValue}. Use split or unified.");
    }

    return normalizedValue;
}

async Task SendSignalingMessageAsync(ClientWebSocket signalingSocket, string streamId, object message)
{
    var sendLock = signalingSendLocks.GetOrAdd(streamId, _ => new SemaphoreSlim(1, 1));
    await sendLock.WaitAsync();
    try
    {
        await signalingSocket.SendAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(message)),
            WebSocketMessageType.Text,
            true,
            CancellationToken.None);
    }
    finally
    {
        sendLock.Release();
    }
}

string GenerateSignature(string clientId, string meetingUuid, string streamId, string secret)
{
    var message = $"{clientId},{meetingUuid},{streamId}";
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    return BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(message))).Replace("-", "").ToLowerInvariant();
}

app.Run($"http://0.0.0.0:{port}");
