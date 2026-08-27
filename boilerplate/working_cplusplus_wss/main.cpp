#include <iostream>
#include <thread>
#include <vector>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <atomic>
#include <csignal>
#include "utils.h"
#include "nlohmann/json.hpp"
#include <websocketpp/config/asio_client.hpp>
#include <websocketpp/client.hpp>
#include <boost/asio/ssl/context.hpp>
#include <boost/asio/signal_set.hpp>

#include "signaling_ws.h"
#include "media_ws.h"
#include "oauth.h"

using json = nlohmann::json;
using client =  websocketpp::client<websocketpp::config::asio_tls_client>;
using message_ptr = websocketpp::config::asio_client::message_type::ptr;

std::string CLIENT_ID;
std::string CLIENT_SECRET;
int MEDIA_TYPES_FLAG = 11;
std::string MEDIA_SOCKET_CONNECTION_MODE = "split";

void on_message_event(client* c, websocketpp::connection_hdl hdl, message_ptr msg) {
    try {
        auto outer = json::parse(msg->get_payload());
        std::cout << "[Event WS] Raw message:\n" << outer.dump(2) << "\n";

        if (!outer.contains("content") || !outer["content"].is_string()) {
            std::cout << "ℹ️ Ignored message without string 'content'\n";
            return;
        }

        const std::string& content_str = outer["content"];

        // ✅ Only parse if content looks like JSON
        if (content_str.empty() || content_str[0] != '{') {
            std::cout << "ℹ️ Skipping non-JSON content: " << content_str << "\n";
            return;
        }

        json inner = json::parse(content_str);
        if (inner.contains("event") && inner["event"] == "meeting.rtms_started") {
            const auto& payload = inner["payload"];
            std::string signaling_url = payload.value("server_urls", "");
            std::string meeting_uuid = payload["meeting_uuid"];
            std::string stream_id = payload["rtms_stream_id"];


            if (signaling_url.empty()) {
                std::cerr << "❌ Missing 'server_urls' in rtms_started payload\n";
                return;
            }

            std::cout << "🚀 RTMS Started: Connecting to signaling server at: " << signaling_url << "\n";

            std::thread([signaling_url, meeting_uuid, stream_id]() {
                connect_to_signaling_server(signaling_url, meeting_uuid, stream_id);
            }).detach();
        } else {
            std::cout << "ℹ️ Other event received: " << inner.value("event", "unknown") << "\n";
        }

    } catch (const std::exception& e) {
        std::cerr << "[Event WS] JSON parse error: " << e.what() << "\n";
    }
}





void connect_to_event_server(const std::string& url) {
    client c;
    c.init_asio();
    std::atomic<bool> stopping{false};
    websocketpp::connection_hdl event_handle;
    bool connected = false;
    std::thread heartbeat_thread;

    boost::asio::signal_set signals(c.get_io_service(), SIGINT, SIGTERM);
    signals.async_wait([&](const boost::system::error_code& error, int signal_number) {
        if (error) return;
        std::cout << "Received signal " << signal_number << "; shutting down\n";
        stopping = true;
        if (connected) {
            websocketpp::lib::error_code close_error;
            c.close(event_handle, websocketpp::close::status::normal, "Server shutdown", close_error);
        }
    });

    c.set_tls_init_handler([](websocketpp::connection_hdl) {
        return websocketpp::lib::make_shared<boost::asio::ssl::context>(
            boost::asio::ssl::context::tlsv12_client
        );
    });

    // 🌐 Handle messages
    c.set_message_handler([&](websocketpp::connection_hdl hdl, message_ptr msg) {
        on_message_event(&c, hdl, msg);
    });

    // 🫀 Handle connection open: send initial heartbeat + start periodic thread
    c.set_open_handler([&](websocketpp::connection_hdl hdl) {
        event_handle = hdl;
        connected = true;
        std::cout << "✅ Event WebSocket connected — starting heartbeat\n";

        heartbeat_thread = std::thread([&c, hdl, &stopping]() {
            try {
                json initial = {{"module", "heartbeat"}};
                c.send(hdl, initial.dump(), websocketpp::frame::opcode::text);
                std::cout << "💓 Sent initial heartbeat\n";
            } catch (const std::exception& e) {
                std::cerr << "❌ Failed to send initial heartbeat: " << e.what() << "\n";
                return;
            }

            while (!stopping) {
                for (int elapsed = 0; elapsed < 30 && !stopping; ++elapsed) {
                    std::this_thread::sleep_for(std::chrono::seconds(1));
                }
                if (stopping) break;
                try {
                    json hb = {{"module", "heartbeat"}};
                    c.send(hdl, hb.dump(), websocketpp::frame::opcode::text);
                    std::cout << "💓 Heartbeat sent\n";
                } catch (const std::exception& e) {
                    std::cerr << "❌ Heartbeat error: " << e.what() << "\n";
                    break;
                }
            }
        });
    });

    c.set_close_handler([&](websocketpp::connection_hdl) {
        connected = false;
        stopping = true;
    });

    // Connect
    websocketpp::lib::error_code ec;
    auto con = c.get_connection(url, ec);
    if (ec) {
        std::cerr << "❌ Event connection error: " << ec.message() << "\n";
        return;
    }

    c.connect(con);
    c.run(); // blocking
    stopping = true;
    if (heartbeat_thread.joinable()) heartbeat_thread.join();
}

int main() {
    auto env = load_env(".env");

    const auto config_value = [&env](const std::string& key) {
        const char* process_value = std::getenv(key.c_str());
        return process_value ? std::string(process_value) : env[key];
    };

    CLIENT_ID = config_value("CLIENT_ID");
    CLIENT_SECRET = config_value("CLIENT_SECRET");
    const auto media_types_flag = config_value("MEDIA_TYPES_FLAG");
    if (!media_types_flag.empty()) {
        MEDIA_TYPES_FLAG = std::stoi(media_types_flag);
    }
    const auto media_socket_connection_mode = config_value("MEDIA_SOCKET_CONNECTION_MODE");
    if (!media_socket_connection_mode.empty()) {
        MEDIA_SOCKET_CONNECTION_MODE = media_socket_connection_mode;
        std::transform(
            MEDIA_SOCKET_CONNECTION_MODE.begin(), MEDIA_SOCKET_CONNECTION_MODE.end(),
            MEDIA_SOCKET_CONNECTION_MODE.begin(), ::tolower);
    }

    constexpr int all_individual_media_flags = 1 | 2 | 4 | 8 | 16;
    if (MEDIA_TYPES_FLAG != 32 &&
        (MEDIA_TYPES_FLAG <= 0 || (MEDIA_TYPES_FLAG & ~all_individual_media_flags) != 0)) {
        std::cerr << "MEDIA_TYPES_FLAG must combine 1, 2, 4, 8, and 16, or be 32\n";
        return 1;
    }
    if (MEDIA_SOCKET_CONNECTION_MODE != "split" && MEDIA_SOCKET_CONNECTION_MODE != "unified") {
        std::cerr << "MEDIA_SOCKET_CONNECTION_MODE must be split or unified\n";
        return 1;
    }
    if (MEDIA_SOCKET_CONNECTION_MODE == "unified" && MEDIA_TYPES_FLAG != 32) {
        std::cerr << "Unified mode requires MEDIA_TYPES_FLAG=32\n";
        return 1;
    }

    std::cout << "Media mode=" << MEDIA_SOCKET_CONNECTION_MODE
              << " media types=" << MEDIA_TYPES_FLAG << std::endl;

    std::string base_ws_url = config_value("ZOOM_EVENT_WS");
    std::cout << "EVENT WS = [" << base_ws_url << "]" << std::endl;
    
    std::string access_token = get_zoom_access_token(CLIENT_ID, CLIENT_SECRET);
    if (access_token.empty()) {
        std::cerr << "❌ Failed to get Zoom access token.\n";
        return 1;
    }

  std::string full_ws_url = base_ws_url + "&access_token=" + access_token;
  std::cout << "FULL WS url = [" << base_ws_url << "]" << std::endl;

    // Step 1: Get signaling server URL from event
    connect_to_event_server(full_ws_url);
 

}
