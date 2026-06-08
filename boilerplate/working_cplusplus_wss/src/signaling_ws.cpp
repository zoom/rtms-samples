#include "signaling_ws.h"
#include "nlohmann/json.hpp"
#include <websocketpp/config/asio_client.hpp>
#include <websocketpp/client.hpp>
#include <boost/asio/ssl/context.hpp>
#include "utils.h"      
#include <iostream>
#include <mutex>
#include <unordered_set>
#include "media_ws.h"

using json = nlohmann::json;
using client = websocketpp::client<websocketpp::config::asio_tls_client>;
using message_ptr = websocketpp::config::asio_client::message_type::ptr;


extern std::string CLIENT_ID;
extern std::string CLIENT_SECRET;

static std::mutex g_stream_lock_mu;
static std::unordered_set<std::string> g_stream_locks;


void connect_to_signaling_server(const std::string& server_url, const std::string& meeting_uuid, const std::string& stream_id) {
    {
        std::lock_guard<std::mutex> guard(g_stream_lock_mu);
        if (g_stream_locks.find(stream_id) != g_stream_locks.end()) {
            std::cout << "⚠️ Duplicate signaling handshake blocked for stream " << stream_id << "\n";
            return;
        }
        g_stream_locks.insert(stream_id);
    }

    using client = websocketpp::client<websocketpp::config::asio_tls_client>;
    client c;
    c.init_asio();

    c.set_tls_init_handler([](websocketpp::connection_hdl) {
        return websocketpp::lib::make_shared<boost::asio::ssl::context>(
            boost::asio::ssl::context::tlsv12_client
        );
    });

    c.set_open_handler([&](websocketpp::connection_hdl hdl) {
        json handshake = {
            {"msg_type", 1},
            {"protocol_version", 1},
            {"meeting_uuid", meeting_uuid},
            {"rtms_stream_id", stream_id},
            {"sequence", rand()},
            {"signature", generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)},
            {"buffer_data", false}
        };
        c.send(hdl, handshake.dump(), websocketpp::frame::opcode::text);
        std::cout << "🤝 Sent signaling handshake\n";
    });

    c.set_message_handler([&](websocketpp::connection_hdl hdl, message_ptr msg) {
        auto payload = json::parse(msg->get_payload());
        int msg_type = payload.value("msg_type", -1);

        if (msg_type == 2) {
            if (payload.value("status_code", -1) == 0) {
                auto media_url = payload["media_server"]["server_urls"]["all"];
                std::cout << "🎥 Media server URL: " << media_url << "\n";

                std::thread([=]() {
                    connect_to_media_server(media_url, meeting_uuid, stream_id, hdl); // pass signaling socket hdl
                }).detach();
            } else {
                std::cout << "⚠️ Signaling handshake failed for stream " << stream_id
                          << " status=" << payload.value("status_code", -1)
                          << " reason=" << payload.value("reason", "") << "\n";
            }
        } else if (msg_type == 12) {
            json pong = {
                {"msg_type", 13},
                {"timestamp", payload["timestamp"]}
            };
            c.send(hdl, pong.dump(), websocketpp::frame::opcode::text);
            std::cout << "🔁 Responded to signaling KEEP_ALIVE_REQ\n";
        }
    });

    websocketpp::lib::error_code ec;
    auto con = c.get_connection(server_url, ec);
    if (ec) {
        std::cerr << "❌ Signaling connection error: " << ec.message() << "\n";
        return;
    }

    c.connect(con);
    c.run();

    {
        std::lock_guard<std::mutex> guard(g_stream_lock_mu);
        g_stream_locks.erase(stream_id);
    }
}
