#pragma once
#include <string>
#include <map>

std::map<std::string, std::string> load_env(const std::string& filename);
std::string generate_signature(const std::string& client_id,
                               const std::string& meeting_uuid,
                               const std::string& stream_id,
                               const std::string& client_secret);
