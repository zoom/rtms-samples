package com.zoom.rtms.workingjava.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import lombok.Getter;
import jakarta.annotation.PostConstruct;

@Configuration
@Getter
public class AppConfig {

    @Value("${APP_MODE:webhook}")
    private String mode;

    @Value("${APP_WEBHOOK_PATH:/webhook}")
    private String webhookPath;

    @Value("${MEDIA_TYPES_FLAG:11}")
    private int mediaTypesFlag;

    @Value("${MEDIA_SOCKET_CONNECTION_MODE:split}")
    private String mediaSocketConnectionMode;

    @PostConstruct
    public void validateMediaConfiguration() {
        mediaSocketConnectionMode = mediaSocketConnectionMode.trim().toLowerCase();
        int allIndividualMediaFlags = 1 | 2 | 4 | 8 | 16;
        if (mediaTypesFlag != 32 &&
                (mediaTypesFlag <= 0 || (mediaTypesFlag & ~allIndividualMediaFlags) != 0)) {
            throw new IllegalArgumentException(
                    "MEDIA_TYPES_FLAG must combine 1, 2, 4, 8, and 16, or be 32");
        }
        if (!mediaSocketConnectionMode.equals("split") && !mediaSocketConnectionMode.equals("unified")) {
            throw new IllegalArgumentException("MEDIA_SOCKET_CONNECTION_MODE must be split or unified");
        }
        if (mediaSocketConnectionMode.equals("unified") && mediaTypesFlag != 32) {
            throw new IllegalArgumentException("Unified mode requires MEDIA_TYPES_FLAG=32");
        }
    }
}
