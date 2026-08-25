cmake_minimum_required(VERSION 3.20)
project(RLOverlayPlugin CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The BakkesMod SDK ships with the BakkesMod installation.
if(NOT DEFINED BAKKESMOD_SDK)
    set(BAKKESMOD_SDK "$ENV{APPDATA}/bakkesmod/bakkesmod/bakkesmodsdk")
endif()

if(NOT EXISTS "${BAKKESMOD_SDK}/include")
    message(FATAL_ERROR "BakkesMod SDK not found in ${BAKKESMOD_SDK}. Pass -DBAKKESMOD_SDK=<path>.")
endif()

add_library(RLOverlayPlugin SHARED
    src/RLOverlayPlugin.cpp
    src/WsServer.cpp
)

target_include_directories(RLOverlayPlugin PRIVATE "${BAKKESMOD_SDK}/include")
# ws2_32 for the WebSocket server's sockets, bcrypt for the SHA-1 its handshake
# needs. Both ship with Windows: the plugin has no vendored dependency.
target_link_libraries(RLOverlayPlugin PRIVATE
    "${BAKKESMOD_SDK}/lib/pluginsdk.lib"
    ws2_32
    bcrypt
)

# The SDK is built for x64 / MSVC; the wrappers use STL types in their
# interface, hence silencing C4251.
target_compile_definitions(RLOverlayPlugin PRIVATE
    _CRT_SECURE_NO_WARNINGS
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)
target_compile_options(RLOverlayPlugin PRIVATE /wd4251)

# BakkesMod loads DLLs from its plugins folder.
set(BAKKESMOD_PLUGINS "$ENV{APPDATA}/bakkesmod/bakkesmod/plugins")
add_custom_command(TARGET RLOverlayPlugin POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "$<TARGET_FILE:RLOverlayPlugin>" "${BAKKESMOD_PLUGINS}/RLOverlayPlugin.dll"
    COMMENT "Copying the plugin to ${BAKKESMOD_PLUGINS}"
)
