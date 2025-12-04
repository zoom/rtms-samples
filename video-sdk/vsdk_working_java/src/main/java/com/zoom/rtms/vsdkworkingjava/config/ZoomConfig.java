package com.zoom.rtms.vsdkworkingjava.config;

import jakarta.annotation.PostConstruct;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;

@Configuration
@Getter
@Slf4j
public class ZoomConfig {

    @Value("${ZOOM_CLIENT_ID:xxxxxx}")
    private String clientId;

    @Value("${ZOOM_CLIENT_SECRET:yyyyyyy}")
    private String clientSecret;

    @Value("${ZOOM_SECRET_TOKEN:zzzzzz}")
    private String secretToken;

    @PostConstruct
    public void init() {
        log.info("ZoomConfig initialized:");
        log.info("  Client ID loaded: {}", clientId != null ? "YES (" + clientId.substring(0, 8) + "...)" : "NO");
        log.info("  Client Secret loaded: {}", clientSecret != null ? "YES (" + clientSecret.substring(0, 8) + "...)" : "NO");
        log.info("  Secret Token loaded: {}", secretToken != null ? "YES (" + secretToken.substring(0, 8) + "...)" : "NO");
    }
}
