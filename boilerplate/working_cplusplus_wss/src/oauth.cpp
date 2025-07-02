#include "oauth.h"
#include <curl/curl.h>
#include <sstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <openssl/buffer.h>

using json = nlohmann::json;

static std::string base64_encode(const std::string& input) {
    BIO *bio, *b64;
    BUF_MEM *buffer_ptr;
    b64 = BIO_new(BIO_f_base64());
    bio = BIO_new(BIO_s_mem());
    BIO_push(b64, bio);
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_write(b64, input.c_str(), input.size());
    BIO_flush(b64);
    BIO_get_mem_ptr(b64, &buffer_ptr);
    std::string result(buffer_ptr->data, buffer_ptr->length);
    BIO_free_all(b64);
    return result;
}

static size_t write_callback(void* contents, size_t size, size_t nmemb, std::string* output) {
    size_t total_size = size * nmemb;
    output->append((char*)contents, total_size);
    return total_size;
}

std::string get_zoom_access_token(const std::string& client_id, const std::string& client_secret) {
    std::cout << "🔐 Preparing to request Zoom access token...\n";
    std::cout << "📛 CLIENT_ID: " << client_id << "\n";
    std::cout << "🔒 CLIENT_SECRET: " << std::string(client_secret.size(), '*') << "\n"; // hide secret

    CURL* curl = curl_easy_init();
    std::string response_str;

    if (!curl) {
        std::cerr << "❌ Failed to initialize CURL\n";
        return "";
    }

    std::string url = "https://zoom.us/oauth/token?grant_type=client_credentials";
    std::string creds = client_id + ":" + client_secret;
    std::string encoded_creds = base64_encode(creds);

    //std::cout << "🔑 Raw credentials: " << creds << "\n";
    //std::cout << "🔑 Encoded Base64: " << encoded_creds << "\n";

    struct curl_slist* headers = nullptr;
    std::string auth_header = "Authorization: Basic " + encoded_creds;
    headers = curl_slist_append(headers, auth_header.c_str());
    headers = curl_slist_append(headers, "Content-Type: application/x-www-form-urlencoded");


    //std::cout << "🌐 Request URL: " << url << "\n";
    //std::cout << "📨 Request Headers:\n  - " << auth_header << "\n";

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_str);

    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, "");

    //curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
    CURLcode res = curl_easy_perform(curl);

    
    if (res != CURLE_OK) {
        std::cerr << "❌ curl_easy_perform() failed: "
                << curl_easy_strerror(res) << " (code: " << res << ")\n";
    } else {
        std::cout << "✅ curl_easy_perform succeeded\n";
    }
    
    //std::cout << "📦 Response: " << response_str << "\n";

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);



    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    //std::cout << "📬 HTTP Response Code: " << http_code << "\n";
    //std::cout << "📦 Response Body: " << response_str << "\n";

    if (res != CURLE_OK) {
        std::cerr << "❌ curl_easy_perform() failed: " << curl_easy_strerror(res) << "\n";
        return "";
    }

    if (http_code == 200) {
        json parsed = json::parse(response_str, nullptr, false);
        if (parsed.contains("access_token")) {
            std::string token = parsed["access_token"].get<std::string>();
            std::cout << "✅ Access token received: " << token.substr(0, 8) << "... (truncated)\n";
            return token;
        } else {
            std::cerr << "⚠️  Response does not contain 'access_token'\n";
        }
    } else {
        std::cerr << "❌ Unexpected HTTP status: " << http_code << "\n";
    }

    return "";
}
