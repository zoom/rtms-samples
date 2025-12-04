package com.zoom.rtms.vsdkworkingjava.controller;

import com.zoom.rtms.vsdkworkingjava.config.AppConfig;
import com.zoom.rtms.vsdkworkingjava.config.ZoomConfig;
import com.zoom.rtms.vsdkworkingjava.model.WebhookEvent;
import com.zoom.rtms.vsdkworkingjava.service.RtmsService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.scheduling.annotation.Async;
import org.springframework.web.bind.annotation.*;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.util.Base64;
import java.util.Map;

@RestController
@RequiredArgsConstructor
@Slf4j
@RequestMapping("${APP_WEBHOOK_PATH:/webhook}")
public class WebhookController {

    private final RtmsService rtmsService;
    private final ZoomConfig zoomConfig;
    private final AppConfig appConfig;

    @PostMapping
    public ResponseEntity<Map<String, String>> handleWebhook(@RequestBody WebhookEvent webhookEvent) {
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
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate validation token", e);
        }
    }
}
