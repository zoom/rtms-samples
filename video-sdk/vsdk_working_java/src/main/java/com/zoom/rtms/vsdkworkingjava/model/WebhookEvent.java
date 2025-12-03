package com.zoom.rtms.vsdkworkingjava.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.Map;

@JsonIgnoreProperties(ignoreUnknown = true)
public record WebhookEvent(
        String event,
        Map<String, Object> payload
) {
}
