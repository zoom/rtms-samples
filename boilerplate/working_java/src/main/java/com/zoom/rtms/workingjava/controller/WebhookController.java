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
import java.util.Base64;
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
            @RequestBody WebhookEvent webhookEvent,
            HttpServletResponse response) throws IOException {
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
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException("Failed to generate validation token", e);
        }
    }
}
