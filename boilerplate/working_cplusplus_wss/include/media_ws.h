#pragma once
#include <functional>
#include <string>



void connect_to_media_server(
    const std::string& media_url,
    const std::string& meeting_uuid,
    const std::string& stream_id,
    const std::function<void()>& send_ready_ack,
    const std::string& media_name,
    int media_type
);
