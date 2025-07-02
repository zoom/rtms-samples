#pragma once
#include <string>
#include <websocketpp/connection.hpp>



void connect_to_media_server(
    const std::string& media_url,
    const std::string& meeting_uuid,
    const std::string& stream_id,
    websocketpp::connection_hdl signaling_hdl
);