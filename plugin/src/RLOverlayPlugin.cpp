#include "RLOverlayPlugin.h"

#include "bakkesmod/wrappers/includes.h"

#include <cstdio>
#include <string>
#include <vector>

// The name shown in BakkesMod's plugin manager matches the published listing.
// The DLL, the load command and the cvar prefix keep their original names: they
// are what anyone already running this typed, and renaming them would cost more
// than the tidiness is worth.
BAKKESMOD_PLUGIN(RLOverlayPlugin, "Input Bridge - driver inputs on a local WebSocket",
	"1.0.1", PLUGINTYPE_FREEPLAY)

namespace {

constexpr int kSendHz = 120;

// Free port next to the neighbours a BakkesMod user is likely to already run:
// SOS sits on 49122, RocketLink on 49124.
constexpr int kDefaultWsPort = 49200;
constexpr char kPortCvar[] = "rloverlay_ws_port";
constexpr char kFileOriginCvar[] = "rloverlay_ws_allow_file_origin";

constexpr char kInputHook[] = "Function TAGame.Car_TA.SetVehicleInput";

// UE3 Rotator -> degrees. Pitch ±16384, Yaw/Roll ±32768 for a half/full turn.
inline float RotToDeg(int v) { return v * (360.0f / 65536.0f); }

inline float Dot(const Vector& a, const Vector& b) {
	return a.X * b.X + a.Y * b.Y + a.Z * b.Z;
}

// World angular velocity -> car frame. Without this there's no telling a pitch
// from a roll: only the component around the car's right axis corresponds to
// the rotation a forward/backward flip produces.
struct LocalRates { float pitch, yaw, roll; };

LocalRates ToLocalRates(const Rotator& rot, const Vector& angVel) {
	Quat q = RotatorToQuat(rot);
	Vector fwd = RotateVectorWithQuat(Vector(1, 0, 0), q);
	Vector right = RotateVectorWithQuat(Vector(0, 1, 0), q);
	Vector up = RotateVectorWithQuat(Vector(0, 0, 1), q);
	return { Dot(angVel, right), Dot(angVel, up), Dot(angVel, fwd) };
}

std::string JsonEscape(const std::string& s) {
	std::string out;
	out.reserve(s.size());
	for (char c : s) {
		if (c == '"' || c == '\\') { out += '\\'; out += c; }
		else if (c >= 0 && c < 0x20) { /* drop control characters */ }
		else out += c;
	}
	return out;
}

} // namespace

void RLOverlayPlugin::onLoad() {
	CVarWrapper portCvar = cvarManager->registerCvar(
		kPortCvar, std::to_string(kDefaultWsPort),
		"Port of the overlay's WebSocket server (loopback only)", true, true, 1024, true, 65535);

	ws_ = std::make_unique<WsServer>(
		static_cast<unsigned short>(portCvar.getIntValue()), kSendHz);
	ws_->SetLogger([this](const std::string& msg) { cvarManager->log("[ws] " + msg); });

	// Changing the port from the console rebinds on the spot: reloading the
	// plugin to move a port would be a poor way to find a free one.
	portCvar.addOnValueChanged([this](std::string, CVarWrapper cvar) {
		if (ws_) ws_->Rebind(static_cast<unsigned short>(cvar.getIntValue()));
	});

	// A page opened straight off disk reports no origin of its own, and that is
	// how the overlay runs in an OBS browser source with nothing else going. A
	// sandboxed iframe on a hostile page reports exactly the same thing, and the
	// handshake has no way to tell them apart — so whoever doesn't use the
	// file:// route can close that door.
	CVarWrapper fileCvar = cvarManager->registerCvar(
		kFileOriginCvar, "1",
		"Accept file:// and other origin-less pages on the overlay socket",
		true, true, 0, true, 1);
	ws_->SetAllowOpaqueOrigin(fileCvar.getBoolValue());
	fileCvar.addOnValueChanged([this](std::string, CVarWrapper cvar) {
		if (ws_) ws_->SetAllowOpaqueOrigin(cvar.getBoolValue());
	});

	ws_->Start();

	gameWrapper->HookEventWithCaller<CarWrapper>(
		kInputHook,
		[this](CarWrapper car, void*, std::string) { OnSetVehicleInput(car); });

	// Settings must go out even outside a match (menus, pause): the input hook
	// only runs when a car exists, hence a separate timer.
	ScheduleSettingsTick();

	cvarManager->log("Input Bridge loaded - ws://127.0.0.1:"
		+ std::to_string(portCvar.getIntValue()));
}

void RLOverlayPlugin::onUnload() {
	// The hook holds a lambda that captures `this`, and it is registered by
	// event name with no mention of which plugin asked for it. Letting it
	// outlive the object it calls into is not worth relying on BakkesMod to
	// prevent — the cost of being explicit is one line.
	gameWrapper->UnhookEvent(kInputHook);
	if (ws_) ws_->Stop();
	ws_.reset();
}

// Controller settings + bindings: read from the game, not configured by hand.
// Read back periodically to follow a change made in the menus.
void RLOverlayPlugin::PushSettings() {
	SettingsWrapper settings = gameWrapper->GetSettings();
	GamepadSettings gp = settings.GetGamepadSettings();

	std::string json;
	json.reserve(2048);

	char head[256];
	snprintf(head, sizeof(head),
		"{\"t\":\"settings\",\"deadzone\":%.4f,\"dodgeThreshold\":%.4f,"
		"\"steerSens\":%.4f,\"airSens\":%.4f,\"bindings\":[",
		gp.ControllerDeadzone, gp.DodgeInputThreshold,
		gp.SteeringSensitivity, gp.AirControlSensitivity);
	json += head;

	// Each pair is (key, action), and the same key shows up several times: the
	// game also binds the editor/dance/replay contexts. So we send the raw
	// list, and let the client keep the driving actions.
	bool first = true;
	for (const auto& [key, action] : settings.GetAllGamepadBindings()) {
		if (key.empty() || key == "None" || action.empty()) continue;
		if (!first) json += ',';
		first = false;
		json += "[\"";
		json += JsonEscape(key);
		json += "\",\"";
		json += JsonEscape(action);
		json += "\"]";
	}
	json += "]}";

	// No point re-emitting an identical blob every second.
	if (json == lastSettingsJson_) return;
	lastSettingsJson_ = json;

	// Two different audiences: whoever is already listening gets it now,
	// whoever connects later gets it on arrival. Without the second, a client
	// showing up between two changes would never see the settings at all.
	ws_->PublishReliable(json);
	ws_->SetGreeting(json);
}

// Reschedules itself as long as the plugin is loaded. BakkesMod purges a
// plugin's timeouts when it unloads, so the loop stops on its own.
//
// Runs even with nobody listening: that keeps the greeting up to date, so a
// client that arrives gets the settings on its first tick rather than waiting
// out the second.
void RLOverlayPlugin::ScheduleSettingsTick() {
	gameWrapper->SetTimeout([this](GameWrapper*) {
		PushSettings();
		ScheduleSettingsTick();
	}, 1.f);
}

// The plugin's only data source, and it requires driving: SetVehicleInput
// "doesn't fire while spectating matches" (BakkesMod docs). A replay will
// therefore never produce anything here — and it isn't only a matter of the
// hook: a .replay is a trace of network replication (positions, velocities,
// ~30 Hz) that doesn't contain the commands. Settled in docs/sources.md §4:
// seeing a player's inputs requires the live session.
void RLOverlayPlugin::OnSetVehicleInput(CarWrapper car) {
	if (!ws_ || !ws_->IsConnected() || car.IsNull()) return;

	// Only follow the local player's car (spectating / replay = other cars).
	CarWrapper local = gameWrapper->GetLocalCar();
	if (local.IsNull() || local.memory_address != car.memory_address) return;

	ControllerInput in = car.GetInput();

	float boost = 0.f;
	BoostWrapper boostComp = car.GetBoostComponent();
	if (!boostComp.IsNull()) boost = boostComp.GetCurrentBoostAmount();

	// The real dodge as the game applies it: direction and active time. This is
	// the exact source of the flip angle, where inference from the stick could
	// only approximate it.
	float dodgeTime = 0.f, dodgeTorqueTime = 0.f, minDodgeTorqueTime = 0.f;
	Vector dodgeDir{ 0.f, 0.f, 0.f };
	DodgeComponentWrapper dodge = car.GetDodgeComponent();
	if (!dodge.IsNull()) {
		dodgeTime = dodge.GetActiveTime();
		dodgeDir = dodge.GetDodgeDirection();
		// How long the game applies the dodge's torque: this is the real window
		// in which an opposite pitch input can still cancel the rotation, hence
		// the scale of the cancel.
		dodgeTorqueTime = dodge.GetDodgeTorqueTime();
		minDodgeTorqueTime = dodge.GetMinDodgeTorqueTime();
	}

	// The game's real durations rather than guessed constants: useful hold of
	// the first jump, and the window in which the second jump stays possible.
	// JumpForceTime (0.2 s) = how long holding jump keeps adding thrust, hence
	// the real "size" of the jump. Not to be confused with MaxJumpHeightTime
	// (~0.9 s), which is the time to the apex.
	float maxJumpHold = 0.f;
	JumpComponentWrapper jump = car.GetJumpComponent();
	if (!jump.IsNull()) maxJumpHold = jump.GetJumpForceTime();

	Rotator rot = car.GetRotation();
	Vector angVel = car.GetAngularVelocity();
	Vector vel = car.GetVelocity();
	LocalRates rates = ToLocalRates(rot, angVel);

	char buf[1024];
	int n = snprintf(buf, sizeof(buf),
		"{\"t\":\"input\","
		"\"throttle\":%.3f,\"steer\":%.3f,\"pitch\":%.3f,\"yaw\":%.3f,\"roll\":%.3f,"
		"\"dodgeF\":%.3f,\"dodgeS\":%.3f,"
		"\"handbrake\":%u,\"jump\":%u,\"boost\":%u,\"holdBoost\":%u,\"jumped\":%u,"
		"\"onGround\":%u,\"hasFlip\":%u,\"boostAmt\":%.3f,"
		"\"dodgeT\":%.3f,\"dodgeDir\":[%.3f,%.3f,%.3f],"
		"\"dodgeTorqueTime\":%.3f,\"minDodgeTorqueTime\":%.3f,"
		"\"maxJumpHold\":%.3f,\"maxDodgeTime\":%.3f,"
		"\"vel\":[%.1f,%.1f,%.1f],"
		"\"rot\":[%.2f,%.2f,%.2f],\"angVel\":[%.3f,%.3f,%.3f],"
		"\"rates\":[%.3f,%.3f,%.3f]}",
		in.Throttle, in.Steer, in.Pitch, in.Yaw, in.Roll,
		in.DodgeForward, in.DodgeStrafe,
		static_cast<unsigned>(in.Handbrake), static_cast<unsigned>(in.Jump),
		static_cast<unsigned>(in.ActivateBoost), static_cast<unsigned>(in.HoldingBoost),
		static_cast<unsigned>(in.Jumped),
		static_cast<unsigned>(car.IsOnGround() ? 1 : 0),
		static_cast<unsigned>(car.HasFlip() ? 1 : 0),
		boost,
		dodgeTime, dodgeDir.X, dodgeDir.Y, dodgeDir.Z,
		dodgeTorqueTime, minDodgeTorqueTime,
		maxJumpHold, car.GetMaxTimeForDodge(),
		vel.X, vel.Y, vel.Z,
		RotToDeg(rot.Pitch), RotToDeg(rot.Yaw), RotToDeg(rot.Roll),
		angVel.X, angVel.Y, angVel.Z,
		rates.pitch, rates.yaw, rates.roll);

	if (n > 0 && n < static_cast<int>(sizeof(buf))) {
		ws_->Publish(std::string(buf, n));
	}
}
