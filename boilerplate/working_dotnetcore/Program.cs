
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

Console.WriteLine($"DEBUG - PORT: {port}");
Console.WriteLine($"DEBUG - WEBHOOK_PATH: {webhookPath}");

var activeConnections = new ConcurrentDictionary<string, ConcurrentDictionary<string, ClientWebSocket>>();

app.MapPost(webhookPath, async (HttpRequest request, HttpResponse response, ILogger<Program> logger) =>
{
    using var reader = new StreamReader(request.Body);
    var bodyStr = await reader.ReadToEndAsync();
    logger.LogInformation("RTMS Webhook received: {body}", bodyStr);

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

    if (eventType == "meeting.rtms_started")
    {
        var meetingUuid = payload.GetProperty("meeting_uuid").GetString();
        var streamId = payload.GetProperty("rtms_stream_id").GetString();
        var serverUrl = payload.GetProperty("server_urls").GetString();
        Console.WriteLine($"DEBUG - Starting signaling WebSocket for meeting {meetingUuid}, stream {streamId}, server: {serverUrl}");
        _ = ConnectToSignalingWebSocket(meetingUuid, streamId, serverUrl, logger);
    }

    Console.WriteLine($"DEBUG - RTMS stopped event for meeting: {payload.GetProperty("meeting_uuid").GetString()}");
    if (eventType == "meeting.rtms_stopped")
    {
        var meetingUuid = payload.GetProperty("meeting_uuid").GetString();
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

    response.StatusCode = 200;
    await response.CompleteAsync();
});

async Task ConnectToSignalingWebSocket(string meetingUuid, string streamId, string serverUrl, ILogger logger)
{
    var ws = new ClientWebSocket();
    await ws.ConnectAsync(new Uri(serverUrl), CancellationToken.None);

    if (!activeConnections.ContainsKey(meetingUuid))
    {
        activeConnections[meetingUuid] = new ConcurrentDictionary<string, ClientWebSocket>();
    }
    activeConnections[meetingUuid]["signaling"] = ws;

    var signature = GenerateSignature(clientId, meetingUuid, streamId, clientSecret);
    var handshake = new
    {
        msg_type = 1,
        protocol_version = 1,
        meeting_uuid = meetingUuid,
        rtms_stream_id = streamId,
        sequence = new Random().Next(1, int.MaxValue),
        signature
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
                    var mediaUrl = msg.GetProperty("media_server").GetProperty("server_urls").GetProperty("all").GetString();
                    if (mediaUrl != null)
                    {
                        await ConnectToMediaWebSocket(mediaUrl, meetingUuid, streamId, ws, logger);
                    }
                    break;

                case 12:
                    var timestamp = msg.GetProperty("timestamp").GetInt64();
                    var keepAliveResponse = JsonSerializer.Serialize(new { msg_type = 13, timestamp });
                    await ws.SendAsync(Encoding.UTF8.GetBytes(keepAliveResponse), WebSocketMessageType.Text, true, CancellationToken.None);
                    break;
            }
        }
    });
}

async Task ConnectToMediaWebSocket(string mediaUrl, string meetingUuid, string streamId, ClientWebSocket signalingSocket, ILogger logger)
{
    var ws = new ClientWebSocket();
    await ws.ConnectAsync(new Uri(mediaUrl), CancellationToken.None);

    if (!activeConnections.ContainsKey(meetingUuid))
        activeConnections[meetingUuid] = new ConcurrentDictionary<string, ClientWebSocket>();
    activeConnections[meetingUuid]["media"] = ws;

    var signature = GenerateSignature(clientId, meetingUuid, streamId, clientSecret);
    var handshake = new
    {
        msg_type = 3,
        protocol_version = 1,
        meeting_uuid = meetingUuid,
        rtms_stream_id = streamId,
        signature,
        media_type = 32,
        payload_encryption = false,
        media_params = new
        {
            audio = new { content_type = 1, sample_rate = 1, channel = 1, codec = 1, data_opt = 1, send_rate = 100 },
            video = new { codec = 7, resolution = 2, fps = 25 }
        }
    };
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
                        await signalingSocket.SendAsync(
                            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(readyAck)),
                            WebSocketMessageType.Text, true, CancellationToken.None);
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

                    case 17:
                        Console.WriteLine("DEBUG - Transcript data received");
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

string GenerateSignature(string clientId, string meetingUuid, string streamId, string secret)
{
    var message = $"{clientId},{meetingUuid},{streamId}";
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    return BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(message))).Replace("-", "").ToLowerInvariant();
}

app.Run($"http://0.0.0.0:{port}");
