
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
using System.Runtime.InteropServices;

var builder = WebApplication.CreateBuilder(args);
DotEnv.Load();
var app = builder.Build();

var port = Environment.GetEnvironmentVariable("PORT") ?? "3000";
var webhookPath = Environment.GetEnvironmentVariable("WEBHOOK_PATH") ?? "/webhook";
var zoomSecretToken = Environment.GetEnvironmentVariable("ZOOM_SECRET_TOKEN");
var clientId = Environment.GetEnvironmentVariable("ZOOM_CLIENT_ID");
var clientSecret = Environment.GetEnvironmentVariable("ZOOM_CLIENT_SECRET");
var configuredMediaTypes = Environment.GetEnvironmentVariable("RTMS_MEDIA_TYPES") ?? "";
var mediaTypesFlag = ParseMediaTypes(configuredMediaTypes);

Console.WriteLine($"DEBUG - PORT: {port}");
Console.WriteLine($"DEBUG - WEBHOOK_PATH: {webhookPath}");
Console.WriteLine($"DEBUG - RTMS_MEDIA_TYPES: {configuredMediaTypes} (split sockets)");

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

    if (eventType != "endpoint.url_validation" &&
        !VerifyZoomWebhook(request, bodyStr, zoomSecretToken))
    {
        response.StatusCode = string.IsNullOrWhiteSpace(zoomSecretToken)
            ? StatusCodes.Status500InternalServerError
            : StatusCodes.Status401Unauthorized;
        await response.WriteAsJsonAsync(new { error = "invalid_zoom_webhook" });
        return;
    }

    if (eventType == "endpoint.url_validation" && payload.TryGetProperty("plainToken", out var plainTokenEl))
    {
        var plainToken = plainTokenEl.GetString();
        if (string.IsNullOrEmpty(plainToken) || !IsValidPlainToken(plainToken))
        {
            response.StatusCode = StatusCodes.Status400BadRequest;
            await response.WriteAsJsonAsync(new { error = "invalid_plain_token" });
            return;
        }
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

static bool IsValidPlainToken(string? plainToken)
{
    if (string.IsNullOrEmpty(plainToken) || plainToken.Length < 8 || plainToken.Length > 256)
        return false;
    foreach (var c in plainToken)
        if (c < '!' || c > '~') return false;
    return true;
}

// RTMS protocol V2 can list several comma-separated URLs for one endpoint,
// for example "wss://host/ws,srt://host:port". WebSocket connections use the
// first ws/wss entry.
static string? SelectWebSocketUrl(string? value)
{
    if (string.IsNullOrWhiteSpace(value)) return null;
    foreach (var entry in value.Split(','))
    {
        var url = entry.Trim();
        if (url.StartsWith("wss://", StringComparison.OrdinalIgnoreCase) ||
            url.StartsWith("ws://", StringComparison.OrdinalIgnoreCase))
        {
            return url;
        }
    }
    return null;
}

// media_server.server_urls is usually keyed by media type. V2 may return one
// comma-separated string that serves every media type.
static string? GetMediaServerUrl(JsonElement serverUrls, string mediaName)
{
    if (serverUrls.ValueKind == JsonValueKind.String) return serverUrls.GetString();
    if (serverUrls.ValueKind == JsonValueKind.Object &&
        serverUrls.TryGetProperty(mediaName, out var mediaUrl) &&
        mediaUrl.ValueKind == JsonValueKind.String)
    {
        return mediaUrl.GetString();
    }
    return null;
}

static bool VerifyZoomWebhook(HttpRequest request, string rawBody, string secretToken)
{
    if (string.IsNullOrWhiteSpace(secretToken)) return false;
    var signature = request.Headers["x-zm-signature"].ToString();
    var timestamp = request.Headers["x-zm-request-timestamp"].ToString();
    if (string.IsNullOrWhiteSpace(signature) ||
        !long.TryParse(timestamp, out var timestampSeconds)) return false;

    var toleranceSeconds = long.TryParse(
        Environment.GetEnvironmentVariable("WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS"),
        out var configuredTolerance) ? configuredTolerance : 300;
    if (toleranceSeconds > 0 &&
        Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - timestampSeconds) > toleranceSeconds)
        return false;

    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secretToken));
    var hash = Convert.ToHexString(hmac.ComputeHash(
        Encoding.UTF8.GetBytes($"v0:{timestamp}:{rawBody}"))).ToLowerInvariant();
    var expected = Encoding.UTF8.GetBytes($"v0={hash}");
    var received = Encoding.UTF8.GetBytes(signature);
    return expected.Length == received.Length &&
        CryptographicOperations.FixedTimeEquals(expected, received);
}

async Task ConnectToSignalingWebSocket(string meetingUuid, string streamId, string serverUrl, ILogger logger)
{
    // RTMS V2 server_urls can list wss:// and srt:// entries; signaling uses wss://.
    var signalingUrl = SelectWebSocketUrl(serverUrl);
    if (signalingUrl is null)
    {
        signalingInFlight.TryRemove(streamId, out _);
        logger.LogError("No WebSocket signaling URL in server_urls {serverUrl}", serverUrl);
        return;
    }

    var ws = new ClientWebSocket();
    await ws.ConnectAsync(new Uri(signalingUrl), CancellationToken.None);

    var meetingConnections = activeConnections.GetOrAdd(
        meetingUuid, _ => new ConcurrentDictionary<string, ClientWebSocket>());
    meetingConnections["signaling"] = ws;

    var signature = GenerateSignature(clientId, meetingUuid, streamId, clientSecret);
    var handshake = new
    {
        msg_type = 1,
        protocol_version = 2, // RTMS protocol V2; must match the data handshake
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
                        if ((mediaTypesFlag & media.Flag) == 0)
                            continue;

                        var mediaUrl = GetMediaServerUrl(serverUrls, media.Name);
                        if (string.IsNullOrWhiteSpace(mediaUrl))
                        {
                            logger.LogWarning("No {mediaName} media URL returned for stream {streamId}", media.Name, streamId);
                            continue;
                        }

                        mediaConnections.Add(ConnectToMediaWebSocket(
                            mediaUrl, meetingUuid, streamId, ws, media.Name, media.Flag, logger));
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
    // RTMS V2 media URLs can list wss:// and srt:// entries; use the wss:// one.
    var wsMediaUrl = SelectWebSocketUrl(mediaUrl);
    if (wsMediaUrl is null)
    {
        logger.LogWarning("No {mediaName} media URL returned for stream {streamId}", mediaName, streamId);
        return;
    }

    var ws = new ClientWebSocket();
    await ws.ConnectAsync(new Uri(wsMediaUrl), CancellationToken.None);

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
        _ => throw new ArgumentOutOfRangeException(nameof(mediaName), mediaName, "Unsupported media type")
    };
    var handshake = new
    {
        msg_type = 3,
        protocol_version = 2,
        meeting_uuid = meetingUuid,
        rtms_stream_id = streamId,
        signature,
        media_type = mediaType,
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

int ParseMediaTypes(string rawValue)
{
    var mediaFlags = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
    {
        ["audio"] = 1,
        ["video"] = 2,
        ["screenshare"] = 4,
        ["transcript"] = 8,
        ["chat"] = 16,
    };
    var names = rawValue.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (names.Length == 0 || names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != names.Length)
    {
        throw new InvalidOperationException("RTMS_MEDIA_TYPES must list one or more unique media names.");
    }
    return names.Aggregate(0, (flags, name) => flags | (mediaFlags.TryGetValue(name, out var flag)
        ? flag
        : throw new InvalidOperationException($"Unsupported RTMS media type: {name}")));
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

using var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    shutdown.Cancel();
};
using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, context =>
{
    context.Cancel = true;
    shutdown.Cancel();
});

try
{
    app.Urls.Add($"http://0.0.0.0:{port}");
    await app.RunAsync(shutdown.Token);
}
finally
{
    using var closeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
    foreach (var connectionGroup in activeConnections.Values)
    {
        foreach (var socket in connectionGroup.Values)
        {
            try
            {
                if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Server shutdown", closeTimeout.Token);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine($"WebSocket shutdown failed: {error.Message}");
            }
            socket.Dispose();
        }
    }
    activeConnections.Clear();
}
