#pragma once
#include <string>
#include <map>

std::map<std::string, std::string> load_env(const std::string& filename);
std::string generate_signature(const std::string& client_id,
                               const std::string& meeting_uuid,
                               const std::string& stream_id,
                               const std::string& client_secret);

// RTMS protocol V2 can list several comma-separated URLs for one endpoint,
// for example "wss://host/ws,srt://host:port". Returns the first ws/wss entry,
// or an empty string when there is none.
std::string select_websocket_url(const std::string& value);
