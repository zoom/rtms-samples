package com.zoom.rtms.workingjava.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import lombok.Getter;

@Configuration
@Getter
public class AppConfig {

    @Value("${APP_MODE:webhook}")
    private String mode;

    @Value("${APP_WEBHOOK_PATH:/webhook}")
    private String webhookPath;
}
