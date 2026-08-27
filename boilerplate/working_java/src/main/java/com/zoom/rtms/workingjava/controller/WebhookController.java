package com.zoom.rtms.workingjava.controller;

import com.zoom.rtms.workingjava.config.ZoomConfig;
import com.zoom.rtms.workingjava.model.WebhookEvent;
import com.zoom.rtms.workingjava.service.RtmsService;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;

@RestController
@RequiredArgsConstructor
@Slf4j
@RequestMapping("${APP_WEBHOOK_PATH:/webhook}")
public class WebhookController {

    private final RtmsService rtmsService;
    private final ZoomConfig zoomConfig;
    private final ObjectMapper objectMapper;

    @PostMapping
    public void handleWebhook(
            @RequestBody byte[] rawBody,
            @RequestHeader(value = "x-zm-signature", required = false) String signature,
            @RequestHeader(value = "x-zm-request-timestamp", required = false) String timestamp,
            HttpServletResponse response) throws IOException {
        WebhookEvent webhookEvent = objectMapper.readValue(rawBody, WebhookEvent.class);
        if (!"endpoint.url_validation".equals(webhookEvent.event()) &&
                !verifyWebhook(rawBody, signature, timestamp)) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Invalid Zoom webhook");
            return;
        }
        if ("endpoint.url_validation".equals(webhookEvent.event()) &&
                webhookEvent.payload() != null &&
                webhookEvent.payload().containsKey("plainToken")) {

            String plainToken = (String) webhookEvent.payload().get("plainToken");
            String encryptedToken = generateValidationToken(plainToken);

            response.setStatus(HttpServletResponse.SC_OK);
            response.setContentType("application/json");
            objectMapper.writeValue(response.getOutputStream(), Map.of(
                    "plainToken", plainToken,
                    "encryptedToken", encryptedToken));
            response.flushBuffer();
            log.info("Webhook validation response sent");
            return;
        }

        // Commit Zoom's acknowledgement before dispatching RTMS lifecycle work.
        response.setStatus(HttpServletResponse.SC_OK);
        response.flushBuffer();
        log.info("Webhook acknowledged (200 OK): {}", webhookEvent.event());
        rtmsService.handleWebhookEventAsync(webhookEvent);
    }

    private String generateValidationToken(String plainToken) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec secretKey = new SecretKeySpec(
                    zoomConfig.getSecretToken().getBytes(),
                    "HmacSHA256");
            mac.init(secretKey);
            byte[] hash = mac.doFinal(plainToken.getBytes());
            return HexFormat.of().formatHex(hash);
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate validation token", e);
        }
    }

    private boolean verifyWebhook(byte[] rawBody, String signature, String timestamp) {
        try {
            if (zoomConfig.getSecretToken() == null || signature == null || timestamp == null) return false;
            long timestampSeconds = Long.parseLong(timestamp);
            long tolerance = Long.parseLong(
                    System.getenv().getOrDefault("WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS", "300"));
            if (tolerance > 0 && Math.abs(Instant.now().getEpochSecond() - timestampSeconds) > tolerance) {
                return false;
            }
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(zoomConfig.getSecretToken().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String message = "v0:" + timestamp + ":" + new String(rawBody, StandardCharsets.UTF_8);
            String expected = "v0=" + HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
            return MessageDigest.isEqual(
                    expected.getBytes(StandardCharsets.UTF_8),
                    signature.getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            return false;
        }
    }
}
