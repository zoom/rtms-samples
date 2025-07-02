#include "utils.h"
#include <fstream>
#include <sstream>
#include <openssl/hmac.h>
#include <iomanip>

std::map<std::string, std::string> load_env(const std::string& filename) {
    std::ifstream file(filename);
    std::string line;
    std::map<std::string, std::string> env;
    while (std::getline(file, line)) {
        if (line.empty() || line[0] == '#') continue;
        size_t eq_pos = line.find('=');
        if (eq_pos != std::string::npos) {
            std::string key = line.substr(0, eq_pos);
            std::string value = line.substr(eq_pos + 1);
            env[key] = value;
        }
    }
    return env;
}


std::string generate_signature(const std::string& client_id,
                               const std::string& meeting_uuid,
                               const std::string& stream_id,
                               const std::string& client_secret) {
    std::string message = client_id + "," + meeting_uuid + "," + stream_id;

    unsigned char* result;
    unsigned int len = EVP_MAX_MD_SIZE;

    result = HMAC(EVP_sha256(),
                  client_secret.data(), client_secret.size(),
                  reinterpret_cast<const unsigned char*>(message.data()), message.size(),
                  nullptr, nullptr);

    // Convert to hex
    std::ostringstream hex_stream;
    for (int i = 0; i < 32; ++i) {
        hex_stream << std::hex << std::setw(2) << std::setfill('0') << (int)result[i];
    }

    return hex_stream.str();
}