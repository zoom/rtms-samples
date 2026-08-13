#include "media_ws.h"
#include <websocketpp/config/asio_client.hpp>
#include <websocketpp/client.hpp>
#include <boost/asio/ssl/context.hpp>

#include <iostream>
#include "utils.h"

#include "nlohmann/json.hpp"

extern std::string CLIENT_ID;
extern std::string CLIENT_SECRET;

using json = nlohmann::json;
using client = websocketpp::client<websocketpp::config::asio_tls_client>;
using message_ptr = websocketpp::config::asio_client::message_type::ptr;


void connect_to_media_server(
    const std::string& media_url,
    const std::string& meeting_uuid,
    const std::string& stream_id,
    const std::function<void()>& send_ready_ack,
    const std::string& media_name,
    int media_type) {
    using client = websocketpp::client<websocketpp::config::asio_tls_client>;
    client c;
    c.init_asio();

    c.set_tls_init_handler([](websocketpp::connection_hdl) {
        return websocketpp::lib::make_shared<boost::asio::ssl::context>(
            boost::asio::ssl::context::tlsv12_client
        );
    });

    c.set_open_handler([&](websocketpp::connection_hdl hdl) {
        json all_media_params = {
            {"audio", {
                {"content_type", 2}, {"sample_rate", 1}, {"channel", 1},
                {"codec", 1}, {"data_opt", 1}, {"send_rate", 100}
            }},
            {"video", {
                {"content_type", 3}, {"codec", 7}, {"data_opt", 3},
                {"resolution", 2}, {"fps", 25}
            }},
            {"deskshare", {
                {"content_type", 3}, {"codec", 5}, {"resolution", 2}, {"fps", 1}
            }},
            {"transcript", {
                {"content_type", 5}, {"src_language", 9}, {"enable_lid", true}
            }},
            {"chat", {{"content_type", 5}}}
        };
        json media_params = media_name == "all"
            ? all_media_params
            : json{{media_name, all_media_params[media_name]}};
        json handshake = {
            {"msg_type", 3},
            {"protocol_version", 1},
            {"meeting_uuid", meeting_uuid},
            {"rtms_stream_id", stream_id},
            {"signature", generate_signature(CLIENT_ID, meeting_uuid, stream_id, CLIENT_SECRET)},
            {"media_type", media_type},
            {"payload_encryption", false},
            {"media_params", media_params}
        };

        c.send(hdl, handshake.dump(), websocketpp::frame::opcode::text);
        std::cout << "Sent " << media_name << " media handshake\n";
    });

    c.set_message_handler([&](websocketpp::connection_hdl hdl, message_ptr msg) {
        auto payload = json::parse(msg->get_payload());
        int msg_type = payload.value("msg_type", -1);

        if (msg_type == 4 && payload.value("status_code", -1) == 0) {
            std::cout << media_name << " media handshake success\n";
            send_ready_ack();
        } else if (msg_type == 4) {
            std::cerr << media_name << " media handshake failed: " << payload.dump() << "\n";
        } else if (msg_type == 12) {
            c.send(hdl, json({{"msg_type", 13}, {"timestamp", payload["timestamp"]}}).dump(),
                   websocketpp::frame::opcode::text);
            std::cout << "🔁 Responded to media KEEP_ALIVE_REQ\n";
        } else if (msg_type == 14) {
            std::cout << "🔊 Received AUDIO data\n";
        } else if (msg_type == 15) {
            std::cout << "🎥 Received VIDEO data\n";
        } else if (msg_type == 16) {
            std::cout << "Received SCREEN SHARE data\n";
        } else if (msg_type == 17) {
            std::cout << "📝 Received TRANSCRIPT data\n";
        } else if (msg_type == 18) {
            std::cout << "Received CHAT data\n";
        }
    });

    websocketpp::lib::error_code ec;
    auto con = c.get_connection(media_url, ec);
    if (ec) {
        std::cerr << "❌ Media connection error: " << ec.message() << "\n";
        return;
    }

    c.connect(con);
    c.run();
}
