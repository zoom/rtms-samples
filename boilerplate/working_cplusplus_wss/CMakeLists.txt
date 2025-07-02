cmake_minimum_required(VERSION 3.14)
project(ZoomWebSocketClient)

set(CMAKE_CXX_STANDARD 17)

find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(CURL REQUIRED)

include_directories(include external/websocketpp)

add_executable(ZoomWebSocketClient
    main.cpp
    src/utils.cpp
    src/media_ws.cpp
    src/signaling_ws.cpp
    src/oauth.cpp    
)



target_link_libraries(ZoomWebSocketClient
    PRIVATE
    boost_system
    ${OPENSSL_LIBRARIES}
    CURL::libcurl
    Threads::Threads
)

target_include_directories(ZoomWebSocketClient
    PRIVATE
    include
    external/websocketpp
    ${OPENSSL_INCLUDE_DIR}
    ${CURL_INCLUDE_DIRS}
)

# Set output directory for the binary
set_target_properties(ZoomWebSocketClient PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/bin
)

# Copy .env to bin/ folder after build
add_custom_command(TARGET ZoomWebSocketClient POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_SOURCE_DIR}/bin
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        ${CMAKE_SOURCE_DIR}/.env
        ${CMAKE_SOURCE_DIR}/bin/.env
)