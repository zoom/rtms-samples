#include <iostream>
#include <thread>
#include <vector>
#include "utils.h"
#include "nlohmann/json.hpp"
#include <websocketpp/config/asio_client.hpp>
#include <websocketpp/client.hpp>
#include <boost/asio/ssl/context.hpp>

#include "signaling_ws.h"
#include "media_ws.h"
#include "oauth.h"

using json = nlohmann::json;
using client =  websocketpp::client<websocketpp::config::asio_tls_client>;
using message_ptr = websocketpp::config::asio_client::message_type::ptr;

std::string CLIENT_ID;
std::string CLIENT_SECRET;

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
        std::cout << "✅ Event WebSocket connected — starting heartbeat\n";

        std::thread([&c, hdl]() {
            try {
                json initial = {{"module", "heartbeat"}};
                c.send(hdl, initial.dump(), websocketpp::frame::opcode::text);
                std::cout << "💓 Sent initial heartbeat\n";
            } catch (const std::exception& e) {
                std::cerr << "❌ Failed to send initial heartbeat: " << e.what() << "\n";
                return;
            }

            while (true) {
                std::this_thread::sleep_for(std::chrono::seconds(30));
                try {
                    json hb = {{"module", "heartbeat"}};
                    c.send(hdl, hb.dump(), websocketpp::frame::opcode::text);
                    std::cout << "💓 Heartbeat sent\n";
                } catch (const std::exception& e) {
                    std::cerr << "❌ Heartbeat error: " << e.what() << "\n";
                    break;
                }
            }
        }).detach();
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
}

int main() {
    auto env = load_env(".env");

    CLIENT_ID = env["CLIENT_ID"];
    CLIENT_SECRET = env["CLIENT_SECRET"];

    std::string base_ws_url = env["ZOOM_EVENT_WS"];
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
