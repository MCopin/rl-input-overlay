#include "WsServer.h"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <cctype>
#include <chrono>

namespace {

// Beyond this, a client is not keeping up with 120 Hz and we stop queueing
// state for it: sending it stale frames helps nobody. Reliable messages keep
// going through — the point of the queue is that they must not be lost.
constexpr size_t kBacklogSoftLimit = 64 * 1024;
// Beyond this it isn't slow, it's gone: drop it and free the slot.
constexpr size_t kBacklogHardLimit = 1024 * 1024;
// A handshake that never completes must not grow without bound.
constexpr size_t kMaxRequestBytes = 16 * 1024;
constexpr int kMaxClients = 8;

// RFC 6455 §1.3: the key the client sends, concatenated with this GUID, hashed
// and base64'd, proves to it that we really are a WebSocket server.
constexpr char kMagic[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

std::string Base64(const unsigned char* data, size_t n) {
	static const char* T =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	std::string out;
	out.reserve(((n + 2) / 3) * 4);
	for (size_t i = 0; i < n; i += 3) {
		unsigned v = static_cast<unsigned>(data[i]) << 16;
		if (i + 1 < n) v |= static_cast<unsigned>(data[i + 1]) << 8;
		if (i + 2 < n) v |= static_cast<unsigned>(data[i + 2]);
		out += T[(v >> 18) & 63];
		out += T[(v >> 12) & 63];
		out += (i + 1 < n) ? T[(v >> 6) & 63] : '=';
		out += (i + 2 < n) ? T[v & 63] : '=';
	}
	return out;
}

// SHA-1 through CNG rather than a copied implementation: it's the one hash the
// handshake needs, and Windows already has it.
bool Sha1(const std::string& in, unsigned char out[20]) {
	BCRYPT_ALG_HANDLE alg = nullptr;
	if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA1_ALGORITHM, nullptr, 0) != 0) return false;
	BCRYPT_HASH_HANDLE hash = nullptr;
	bool ok = BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0
		&& BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(in.data())),
			static_cast<ULONG>(in.size()), 0) == 0
		&& BCryptFinishHash(hash, out, 20, 0) == 0;
	if (hash) BCryptDestroyHash(hash);
	BCryptCloseAlgorithmProvider(alg, 0);
	return ok;
}

std::string Lower(std::string s) {
	std::transform(s.begin(), s.end(), s.begin(),
		[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
	return s;
}

std::string Trim(const std::string& s) {
	size_t a = s.find_first_not_of(" \t");
	if (a == std::string::npos) return {};
	size_t b = s.find_last_not_of(" \t\r");
	return s.substr(a, b - a + 1);
}

// Header lookup on the raw request. Names are case-insensitive (RFC 7230).
std::string Header(const std::string& req, const std::string& name) {
	const std::string lowReq = Lower(req);
	const std::string needle = "\r\n" + Lower(name) + ":";
	size_t at = lowReq.find(needle);
	if (at == std::string::npos) return {};
	size_t from = at + needle.size();
	size_t eol = req.find("\r\n", from);
	if (eol == std::string::npos) return {};
	return Trim(req.substr(from, eol - from));
}

// A listening TCP socket inside an online game is reachable from any page the
// user happens to visit; the browser tells us where it came from, and we only
// take local ones.
//
// The host has to be compared for equality, never by prefix: "http://localhost"
// is a prefix of "http://localhost.evil.com", a domain anybody can register and
// point at whatever they like. So the authority is cut out of the URL properly
// and matched whole.
bool HostIsLoopback(const std::string& lowerOrigin) {
	size_t hostAt;
	if (lowerOrigin.rfind("http://", 0) == 0) hostAt = 7;
	else if (lowerOrigin.rfind("https://", 0) == 0) hostAt = 8;
	else return false;

	const size_t end = lowerOrigin.find_first_of("/?#", hostAt);
	std::string host = lowerOrigin.substr(
		hostAt, end == std::string::npos ? std::string::npos : end - hostAt);

	// An Origin never carries userinfo, and one that does is trying to hide a
	// different host behind "localhost@": refuse rather than guess.
	if (host.find('@') != std::string::npos) return false;

	// Split host from port. Whatever follows the colon has to actually be a
	// port: dropping it unchecked would read "localhost:3947.evil.com" as plain
	// "localhost". No browser can emit that — a port has to parse as a number
	// for the URL to parse at all — but this is the only thing standing between
	// a hostile page and the socket, so it does not get to assume good input.
	size_t colon;
	if (!host.empty() && host[0] == '[') {          // [::1]:3947
		const size_t close = host.find(']');
		if (close == std::string::npos) return false;
		colon = host.find(':', close);
	} else {                                        // localhost:3947
		colon = host.find(':');
	}
	if (colon != std::string::npos) {
		const std::string port = host.substr(colon + 1);
		if (port.empty() || port.size() > 5
			|| port.find_first_not_of("0123456789") != std::string::npos
			|| std::stoi(port) > 65535) {
			return false;
		}
		host.erase(colon);
	}

	return host == "localhost" || host == "127.0.0.1" || host == "[::1]";
}

// allowOpaque covers the origin a page has when it doesn't have one: a file://
// page reports "null", which is what lets the overlay run straight off disk in
// an OBS browser source. A sandboxed iframe on a hostile site reports "null"
// too, and there is no telling the two apart — hence the switch.
bool OriginAllowed(const std::string& origin, bool allowOpaque) {
	// Browsers always send Origin on a WebSocket handshake. No header at all
	// means a script, a probe, the Electron app — something that already has
	// the run of the machine. This filters pages, not tools.
	if (origin.empty()) return true;

	const std::string o = Lower(origin);
	if (o == "null" || o.rfind("file://", 0) == 0) return allowOpaque;

	// OBS does not open a local file as file://. obs-browser serves it under a
	// host of its own invention — "http://absolute/C:/…" — so the page arrives
	// wearing an http origin that names no real host. That is a local file in
	// disguise, and it belongs with the other origin-less pages rather than
	// with actual websites: same meaning, same switch.
	if (o == "http://absolute") return allowOpaque;

	return HostIsLoopback(o);
}

// FIN + text, no mask: server frames are never masked (RFC 6455 §5.1).
std::string EncodeText(const std::string& payload) {
	std::string f;
	f.reserve(payload.size() + 10);
	f += static_cast<char>(0x81);
	const size_t n = payload.size();
	if (n < 126) {
		f += static_cast<char>(n);
	} else if (n <= 0xFFFF) {
		f += static_cast<char>(126);
		f += static_cast<char>((n >> 8) & 0xFF);
		f += static_cast<char>(n & 0xFF);
	} else {
		f += static_cast<char>(127);
		for (int i = 7; i >= 0; --i) f += static_cast<char>((n >> (i * 8)) & 0xFF);
	}
	f += payload;
	return f;
}

void SetNonBlocking(SOCKET s) {
	u_long on = 1;
	ioctlsocket(s, FIONBIO, &on);
}

} // namespace

WsServer::~WsServer() { Stop(); }

void WsServer::Start() {
	if (running_.exchange(true)) return;
	worker_ = std::thread(&WsServer::Run, this);
}

void WsServer::Stop() {
	running_ = false;
	// Joining is not conditional on the flag having been set: Run() clears it
	// itself when it cannot start, and the thread would then still be joinable.
	// Assigning over a joinable std::thread, or destroying one, calls
	// std::terminate — which from inside a plugin means the game goes down.
	if (worker_.joinable()) worker_.join();
	clientCount_ = 0;
}

void WsServer::Rebind(unsigned short port) {
	if (port == port_ && running_.load()) return;
	Stop();
	port_ = port;
	Start();
}

void WsServer::Publish(const std::string& line) {
	std::lock_guard<std::mutex> lock(mtx_);
	pendingFrame_ = line;
	hasFrame_ = true;
}

void WsServer::PublishReliable(const std::string& line) {
	std::lock_guard<std::mutex> lock(mtx_);
	reliableQueue_.push_back(line);
}

void WsServer::SetGreeting(const std::string& line) {
	std::lock_guard<std::mutex> lock(mtx_);
	greeting_ = line;
}

// Answers the upgrade request, or refuses it. Returns false to drop the client;
// leaves c.open false and returns true while the request is still incomplete.
bool WsServer::TryHandshake(Client& c) {
	const size_t end = c.in.find("\r\n\r\n");
	if (end == std::string::npos) return c.in.size() <= kMaxRequestBytes;

	const std::string req = c.in.substr(0, end + 2);
	c.in.erase(0, end + 4);

	const std::string key = Header(req, "Sec-WebSocket-Key");
	const std::string origin = Header(req, "Origin");

	if (key.empty()) {
		const char* r = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
		send(c.sock, r, static_cast<int>(strlen(r)), 0);
		Log("rejected: not a WebSocket handshake");
		return false;
	}
	if (!OriginAllowed(origin, allowOpaqueOrigin_.load())) {
		const char* r = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n";
		send(c.sock, r, static_cast<int>(strlen(r)), 0);
		Log("rejected origin " + origin);
		return false;
	}

	unsigned char digest[20];
	if (!Sha1(key + kMagic, digest)) {
		Log("SHA-1 unavailable, handshake refused");
		return false;
	}

	std::string resp =
		"HTTP/1.1 101 Switching Protocols\r\n"
		"Upgrade: websocket\r\n"
		"Connection: Upgrade\r\n"
		"Sec-WebSocket-Accept: " + Base64(digest, 20) + "\r\n\r\n";
	c.out += resp;
	c.open = true;
	Log("client connected" + (origin.empty() ? std::string() : " from " + origin));
	return true;
}

// We only ever need to notice a close and answer a ping: nothing a client sends
// carries meaning here. Everything else is consumed and dropped.
bool WsServer::ReadClient(Client& c) {
	char buf[4096];
	for (;;) {
		const int n = recv(c.sock, buf, sizeof(buf), 0);
		if (n > 0) {
			c.in.append(buf, n);
			// This loop only ends when the socket runs dry, so a peer that keeps
			// sending faster than we drain would grow this buffer without bound
			// inside the game's process. Nothing a client legitimately sends
			// here comes close: a handshake, a ping, a close.
			if (c.in.size() > kMaxRequestBytes) {
				Log("client dropped: it sent more than a handshake's worth");
				return false;
			}
			continue;
		}
		if (n == 0) return false;                       // clean close
		if (WSAGetLastError() == WSAEWOULDBLOCK) break; // drained
		return false;
	}

	if (!c.open) return TryHandshake(c);

	// Frame decoding, only as far as the opcode and the payload's length.
	for (;;) {
		if (c.in.size() < 2) break;
		const auto b = reinterpret_cast<const unsigned char*>(c.in.data());
		const unsigned opcode = b[0] & 0x0F;
		const bool masked = (b[1] & 0x80) != 0;
		size_t len = b[1] & 0x7F;
		size_t header = 2;

		if (len == 126) {
			if (c.in.size() < 4) break;
			len = (static_cast<size_t>(b[2]) << 8) | b[3];
			header = 4;
		} else if (len == 127) {
			if (c.in.size() < 10) break;
			len = 0;
			for (int i = 0; i < 8; ++i) len = (len << 8) | b[2 + i];
			header = 10;
		}

		// A client that never masks is out of spec, and one announcing a frame
		// this large is not our overlay.
		if (!masked || len > kMaxRequestBytes) return false;
		// Control frames carry at most 125 bytes and are never fragmented
		// (RFC 6455 §5.5). Enforcing it here keeps an oversized ping from
		// turning into an oversized pong that our own clients would choke on.
		if ((opcode & 0x8) != 0 && (len > 125 || (b[0] & 0x80) == 0)) return false;
		header += 4;
		if (c.in.size() < header + len) break;

		if (opcode == 0x8) return false;    // close
		if (opcode == 0x9) {                // ping -> pong, same payload
			std::string payload = c.in.substr(header, len);
			const auto mask = reinterpret_cast<const unsigned char*>(c.in.data()) + header - 4;
			for (size_t i = 0; i < payload.size(); ++i) payload[i] ^= mask[i % 4];
			std::string pong = EncodeText(payload);
			pong[0] = static_cast<char>(0x8A);
			c.out += pong;
		}
		c.in.erase(0, header + len);
	}
	return true;
}

bool WsServer::FlushClient(Client& c) {
	while (!c.out.empty()) {
		const int n = send(c.sock, c.out.data(),
			static_cast<int>(std::min<size_t>(c.out.size(), 64 * 1024)), 0);
		if (n > 0) {
			c.out.erase(0, n);
			continue;
		}
		if (n < 0 && WSAGetLastError() == WSAEWOULDBLOCK) break; // stack full, later
		return false;
	}
	if (c.out.size() > kBacklogHardLimit) {
		Log("client dropped: it stopped reading");
		return false;
	}
	return true;
}

void WsServer::Run() {
	WSADATA wsa{};
	if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
		Log("WSAStartup failed");
		running_ = false;
		return;
	}

	const DWORD periodMs = hz_ > 0 ? static_cast<DWORD>(1000 / hz_) : 8;
	SOCKET listener = INVALID_SOCKET;
	std::vector<Client> clients;

	// Absolute deadlines rather than "wait a period each time round". select()
	// overshoots by about a millisecond, and waiting a fresh full period after
	// each overshoot compounds it: measured against a live game that turned
	// 120 Hz into 111, dropping one frame in fourteen to latest-wins. Advancing
	// the deadline by exactly one period means a late tick is followed by a
	// short wait, and the average comes back to the rate we claim.
	using clock = std::chrono::steady_clock;
	const auto period = std::chrono::milliseconds(periodMs);
	auto nextSend = clock::now();

	// Backing off after a failed bind must not make Stop() slow: the game thread
	// is what joins this one, so a plain Sleep here would freeze the game for
	// its whole duration — on unload, and on every port change.
	auto backOff = [this](int ms) {
		for (int slept = 0; slept < ms && running_.load(); slept += 50) Sleep(50);
	};

	while (running_.load()) {
		if (listener == INVALID_SOCKET) {
			listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
			if (listener == INVALID_SOCKET) {
				Log("socket() failed: " + std::to_string(WSAGetLastError()));
				backOff(1000);
				continue;
			}
			// Without this, another local process can bind the same address with
			// SO_REUSEADDR and take the connections meant for us — a Windows
			// quirk, and the one way a listener like this gets impersonated.
			BOOL exclusive = TRUE;
			setsockopt(listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
				reinterpret_cast<const char*>(&exclusive), sizeof(exclusive));

			sockaddr_in addr{};
			addr.sin_family = AF_INET;
			addr.sin_port = htons(port_);
			// Loopback only. This is a game process: nothing here has any
			// business being reachable from the network.
			inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

			if (bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0
				|| listen(listener, 4) != 0) {
				Log("port " + std::to_string(port_) + " unavailable ("
					+ std::to_string(WSAGetLastError()) + "), retrying");
				closesocket(listener);
				listener = INVALID_SOCKET;
				backOff(2000);
				continue;
			}
			SetNonBlocking(listener);
			Log("listening on 127.0.0.1:" + std::to_string(port_));
		}

		fd_set rd;
		FD_ZERO(&rd);
		FD_SET(listener, &rd);
		for (const auto& c : clients) FD_SET(c.sock, &rd);

		auto waitUs = std::chrono::duration_cast<std::chrono::microseconds>(
			nextSend - clock::now()).count();
		if (waitUs < 0) waitUs = 0;
		if (waitUs > static_cast<long long>(periodMs) * 1000) waitUs = static_cast<long long>(periodMs) * 1000;

		timeval tv{};
		tv.tv_usec = static_cast<long>(waitUs);
		select(0, &rd, nullptr, nullptr, &tv);
		if (!running_.load()) break;

		if (FD_ISSET(listener, &rd)) {
			SOCKET s = accept(listener, nullptr, nullptr);
			if (s != INVALID_SOCKET) {
				if (clients.size() >= kMaxClients) {
					Log("connection refused: too many clients");
					closesocket(s);
				} else {
					SetNonBlocking(s);
					// The frames are small and regular: letting Nagle hold one
					// back waiting for the next would hand back, as latency,
					// exactly what this transport was meant to save.
					BOOL on = TRUE;
					setsockopt(s, IPPROTO_TCP, TCP_NODELAY,
						reinterpret_cast<const char*>(&on), sizeof(on));
					Client c;
					c.sock = s;
					clients.push_back(std::move(c));
				}
			}
		}

		for (auto& c : clients) {
			if (c.sock != INVALID_SOCKET && FD_ISSET(c.sock, &rd) && !ReadClient(c)) {
				closesocket(c.sock);
				c.sock = INVALID_SOCKET;
			}
		}

		// Reads and accepts run every time round; sending is what is paced.
		const bool due = clock::now() >= nextSend;
		if (due) {
			nextSend += period;
			// Stalled long enough that catching up would mean a burst: start
			// the schedule again from here instead.
			if (nextSend + period < clock::now()) nextSend = clock::now() + period;
		}

		// One drain for everybody, encoded once.
		std::vector<std::string> reliable;
		std::string frame;
		if (due) {
			std::lock_guard<std::mutex> lock(mtx_);
			reliable.swap(reliableQueue_);
			if (hasFrame_) {
				frame.swap(pendingFrame_);
				hasFrame_ = false;
			}
			for (auto& c : clients) {
				if (c.open && !c.greeted) {
					c.greeted = true;
					// Settings are only emitted when they change: without this
					// replay a client arriving in between would never see them.
					if (!greeting_.empty()) c.out += EncodeText(greeting_);
				}
			}
		}

		std::string reliableFrames;
		for (const auto& line : reliable) reliableFrames += EncodeText(line);
		const std::string stateFrame = frame.empty() ? std::string() : EncodeText(frame);

		for (auto& c : clients) {
			if (c.sock == INVALID_SOCKET || !c.open) continue;
			if (!reliableFrames.empty()) c.out += reliableFrames;
			// A client already behind gets no stale state piled on: latest-wins
			// only means anything if we stop queueing what it hasn't read.
			if (!stateFrame.empty() && c.out.size() < kBacklogSoftLimit) c.out += stateFrame;
		}

		for (auto& c : clients) {
			if (c.sock == INVALID_SOCKET) continue;
			if (!FlushClient(c)) {
				closesocket(c.sock);
				c.sock = INVALID_SOCKET;
			}
		}

		clients.erase(
			std::remove_if(clients.begin(), clients.end(),
				[](const Client& c) { return c.sock == INVALID_SOCKET; }),
			clients.end());

		int open = 0;
		for (const auto& c : clients) if (c.open) ++open;
		clientCount_ = open;
	}

	for (auto& c : clients) if (c.sock != INVALID_SOCKET) closesocket(c.sock);
	if (listener != INVALID_SOCKET) closesocket(listener);
	clientCount_ = 0;
	WSACleanup();
}
