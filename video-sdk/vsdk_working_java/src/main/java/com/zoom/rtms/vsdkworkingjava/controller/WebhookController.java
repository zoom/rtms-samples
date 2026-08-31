package com.zoom.rtms.vsdkworkingjava.controller;

import com.zoom.rtms.vsdkworkingjava.config.AppConfig;
import com.zoom.rtms.vsdkworkingjava.config.ZoomConfig;
import com.zoom.rtms.vsdkworkingjava.model.WebhookEvent;
import com.zoom.rtms.vsdkworkingjava.service.RtmsService;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.scheduling.annotation.Async;
import org.springframework.web.bind.annotation.*;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
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
    private final AppConfig appConfig;
    private final ObjectMapper objectMapper;

    @PostMapping
    public ResponseEntity<Map<String, String>> handleWebhook(
            @RequestBody byte[] rawBody,
            @RequestHeader(value = "x-zm-signature", required = false) String signature,
            @RequestHeader(value = "x-zm-request-timestamp", required = false) String timestamp) throws Exception {
        WebhookEvent webhookEvent = objectMapper.readValue(rawBody, WebhookEvent.class);
        log.info("Received webhook request");
        log.debug("Request body: {}", webhookEvent);

        // Handle URL validation
        if ("endpoint.url_validation".equals(webhookEvent.event()) &&
                webhookEvent.payload() != null &&
                webhookEvent.payload().containsKey("plainToken")) {

            String plainToken = (String) webhookEvent.payload().get("plainToken");
            String encryptedToken = generateValidationToken(plainToken);

            log.info("Webhook validation response sent");
            return ResponseEntity.ok(Map.of(
                    "plainToken", plainToken,
                    "encryptedToken", encryptedToken));
        }

        if (!verifyWebhook(rawBody, signature, timestamp)) {
            return ResponseEntity.status(401).body(Map.of("error", "invalid_zoom_webhook"));
        }

        // For all other webhooks (rtms_started, rtms_stopped, etc.), respond
        // immediately with 200 OK
        // and process asynchronously in background
        log.info("Webhook acknowledged (200 OK) - processing asynchronously");
        processWebhookAsync(webhookEvent);

        return ResponseEntity.ok().build();
    }

    @Async
    public void processWebhookAsync(WebhookEvent webhookEvent) {
        try {
            log.info("Processing webhook asynchronously: {}", webhookEvent.event());

            // Handle RTMS events asynchronously
            rtmsService.handleWebhookEvent(webhookEvent);

            log.info("Webhook processing completed: {}", webhookEvent.event());
        } catch (Exception e) {
            log.error("Failed to process webhook asynchronously: {}", webhookEvent.event(), e);
        }
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
