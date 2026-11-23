package com.zoom.rtms.vsdkworkingjava.service;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * RTMS protocol V2 URL helpers.
 */
final class RtmsUrls {

    private RtmsUrls() {
    }

    /**
     * RTMS protocol V2 can list several comma-separated URLs for one endpoint,
     * for example "wss://host/ws,srt://host:port". WebSocket connections use
     * the first ws/wss entry. Returns null when there is none.
     */
    static String selectWebSocketUrl(String value) {
        if (value == null) {
            return null;
        }
        for (String entry : value.split(",")) {
            String url = entry.trim();
            if (url.startsWith("wss://") || url.startsWith("ws://")) {
                return url;
            }
        }
        return null;
    }

    /**
     * media_server.server_urls is usually keyed by media type. V2 may return
     * one comma-separated string that serves every media type.
     */
    static String mediaServerUrl(JsonNode serverUrls, String mediaName) {
        if (serverUrls == null || serverUrls.isMissingNode() || serverUrls.isNull()) {
            return "";
        }
        if (serverUrls.isTextual()) {
            return serverUrls.asText();
        }
        return serverUrls.path(mediaName).asText("");
    }
}
