#pragma once
#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// WebSocket server (RFC 6455), text frames, plugin -> client only. The one way
// out of the plugin, and the overlay's only source.
//
// Written by hand rather than pulled from a library: what this needs of the
// protocol is a handshake, a frame encoder, and just enough of the decoder to
// notice a client leaving. Vendoring websocketpp and Asio for that would cost
// the repository far more than it would save. SHA-1 comes from Windows CNG, so
// the DLL only gains ws2_32 and bcrypt — both shipped with the system, nothing
// to fetch or build.
//
// The contract with the game thread: it drops off a string and returns. Every
// send happens on the thread this owns, so a client that stopped reading costs
// a buffer, never a game tick.
//
// It replaced a named pipe, which served one client. The overlay page, an OBS
// source and a second tool are three; here each gets its own outbound buffer.
class WsServer {
public:
	WsServer(unsigned short port, int hz) : port_(port), hz_(hz) {}
	~WsServer();

	// The logger is called from this class's thread, not the game thread.
	void SetLogger(std::function<void(const std::string&)> logger) { logger_ = std::move(logger); }

	void Start();
	void Stop();

	// State frame: last one in wins. No point sending a stale frame when a more
	// recent one is already there.
	void Publish(const std::string& line);

	// Message that must not be lost (settings, bindings): queued, and sent to
	// every client currently connected.
	void PublishReliable(const std::string& line);

	// Line replayed to every client that connects *later*. Settings are emitted
	// only when they change, so a client showing up in between would otherwise
	// never see them — and only this class knows when a new one appears.
	void SetGreeting(const std::string& line);

	bool IsConnected() const { return clientCount_.load() > 0; }

	// Whether a page with no origin of its own ("null", file://) is accepted.
	// On by default: that is what an overlay opened straight off disk reports,
	// and it is a documented way to use this. A sandboxed iframe on a hostile
	// page reports the same thing and cannot be told apart, so it is a switch.
	void SetAllowOpaqueOrigin(bool on) { allowOpaqueOrigin_ = on; }

	// Port changed from the console: come back up on the new one.
	void Rebind(unsigned short port);

	unsigned short Port() const { return port_; }

private:
	struct Client {
		SOCKET sock = INVALID_SOCKET;
		std::string in;     // received, not yet consumed
		std::string out;    // to send, not yet accepted by the stack
		bool open = false;  // handshake done
		bool greeted = false;
	};

	void Run();
	// Each returns false when the client must be dropped.
	bool TryHandshake(Client& c);
	bool ReadClient(Client& c);
	bool FlushClient(Client& c);

	void Log(const std::string& msg) const { if (logger_) logger_(msg); }

	unsigned short port_;
	int hz_;

	std::function<void(const std::string&)> logger_;
	std::thread worker_;
	std::atomic<bool> running_{ false };
	std::atomic<int> clientCount_{ 0 };
	std::atomic<bool> allowOpaqueOrigin_{ true };

	std::mutex mtx_;
	std::string pendingFrame_;
	bool hasFrame_ = false;
	// One entry per message, not one concatenated buffer: a WebSocket message
	// has to *be* one JSON document or the client can't parse it.
	std::vector<std::string> reliableQueue_;
	std::string greeting_;
};
