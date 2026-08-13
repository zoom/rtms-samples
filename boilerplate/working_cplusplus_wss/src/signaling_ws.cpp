#include "signaling_ws.h"
#include "nlohmann/json.hpp"
#include <websocketpp/config/asio_client.hpp>
#include <websocketpp/client.hpp>
#include <boost/asio/ssl/context.hpp>
#include "utils.h"      
#include <iostream>
#include <mutex>
#include <memory>
#include <unordered_set>
#include "media_ws.h"

using json = nlohmann::json;
using client = websocketpp::client<websocketpp::config::asio_tls_client>;
using message_ptr = websocketpp::config::asio_client::message_type::ptr;


extern std::string CLIENT_ID;
extern std::string CLIENT_SECRET;
extern int MEDIA_TYPES_FLAG;
extern std::string MEDIA_SOCKET_CONNECTION_MODE;

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

    auto c = std::make_shared<client>();
    c->init_asio();
    auto signaling_send_mutex = std::make_shared<std::mutex>();

    c->set_tls_init_handler([](websocketpp::connection_hdl) {
        return websocketpp::lib::make_shared<boost::asio::ssl::context>(
            boost::asio::ssl::context::tlsv12_client
        );
    });

    c->set_open_handler([c, meeting_uuid, stream_id, signaling_send_mutex](websocketpp::connection_hdl hdl) {
        json handshake = {
            {"msg_type", 1},
            {"protocol_version", 1},
            {"meeting_uuid", meeting_uuid},
            {"rtms_stream_id", stream_id},
            {"sequence", rand()},
            {"signature", generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)},
            {"buffer_data", false}
        };
        std::lock_guard<std::mutex> guard(*signaling_send_mutex);
        c->send(hdl, handshake.dump(), websocketpp::frame::opcode::text);
        std::cout << "🤝 Sent signaling handshake\n";
    });

    c->set_message_handler([c, meeting_uuid, stream_id, signaling_send_mutex](websocketpp::connection_hdl hdl, message_ptr msg) {
        auto payload = json::parse(msg->get_payload());
        int msg_type = payload.value("msg_type", -1);

        if (msg_type == 2) {
            if (payload.value("status_code", -1) == 0) {
                const auto& media_urls = payload["media_server"]["server_urls"];
                auto send_ready_ack = [c, hdl, stream_id, signaling_send_mutex]() {
                    std::lock_guard<std::mutex> guard(*signaling_send_mutex);
                    json ready_ack = {{"msg_type", 7}, {"rtms_stream_id", stream_id}};
                    c->send(hdl, ready_ack.dump(), websocketpp::frame::opcode::text);
                };

                if (MEDIA_SOCKET_CONNECTION_MODE == "unified") {
                    if (!media_urls.contains("all")) {
                        std::cerr << "Missing server_urls.all for unified mode\n";
                        return;
                    }
                    std::string media_url = media_urls["all"];
                    std::thread([=]() {
                        connect_to_media_server(
                            media_url, meeting_uuid, stream_id, send_ready_ack, "all", 32);
                    }).detach();
                } else {
                    const int requested_flags = MEDIA_TYPES_FLAG == 32 ? 31 : MEDIA_TYPES_FLAG;
                    const std::vector<std::pair<std::string, int>> media_definitions = {
                        {"audio", 1}, {"video", 2}, {"deskshare", 4},
                        {"transcript", 8}, {"chat", 16}
                    };
                    for (const auto& [media_name, media_type] : media_definitions) {
                        if ((requested_flags & media_type) == 0) continue;
                        if (!media_urls.contains(media_name)) {
                            std::cerr << "Missing server_urls." << media_name << "\n";
                            continue;
                        }
                        std::string media_url = media_urls[media_name];
                        std::thread([=]() {
                            connect_to_media_server(
                                media_url, meeting_uuid, stream_id,
                                send_ready_ack, media_name, media_type);
                        }).detach();
                    }
                }
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
            std::lock_guard<std::mutex> guard(*signaling_send_mutex);
            c->send(hdl, pong.dump(), websocketpp::frame::opcode::text);
            std::cout << "🔁 Responded to signaling KEEP_ALIVE_REQ\n";
        }
    });

    websocketpp::lib::error_code ec;
    auto con = c->get_connection(server_url, ec);
    if (ec) {
        std::cerr << "❌ Signaling connection error: " << ec.message() << "\n";
        return;
    }

    c->connect(con);
    c->run();

    {
        std::lock_guard<std::mutex> guard(g_stream_lock_mu);
        g_stream_locks.erase(stream_id);
    }
}
