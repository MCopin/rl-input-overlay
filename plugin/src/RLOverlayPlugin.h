#pragma once
#include <windows.h>

#include <memory>
#include <string>

#include "bakkesmod/plugin/bakkesmodplugin.h"
#include "WsServer.h"

// RL -> overlay bridge. Reads the actions already resolved by the game
// (ControllerInput), the controller settings (deadzone / sensitivities) and the
// car's real rotation, then publishes them as JSON on a local WebSocket.
//
// Anything can read that socket: the Electron app, an overlay page opened as a
// file with nothing else running, a script. The plugin doesn't know or care —
// it publishes, and never blocks on whoever is listening.
class RLOverlayPlugin : public BakkesMod::Plugin::BakkesModPlugin {
public:
	void onLoad() override;
	void onUnload() override;

private:
	void OnSetVehicleInput(CarWrapper car);
	void PushSettings();
	void ScheduleSettingsTick();

	// Built in onLoad, once the port has been read off its cvar.
	std::unique_ptr<WsServer> ws_;
	std::string lastSettingsJson_;
};
