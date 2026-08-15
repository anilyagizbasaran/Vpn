#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);

  // A VPN client is a switch, not a workspace. The whole interface is one
  // button, a line of status and where you are connected — at 1280x720 that
  // was a mostly empty rectangle taking up a third of the screen.
  //
  // Opened near the top right, where a utility window belongs and where it
  // does not land on top of whatever is already in the middle of the screen.
  const int kWidth = 380;
  const int kHeight = 640;

  Win32Window::Point origin(40, 40);
  if (const HWND desktop = ::GetDesktopWindow()) {
    RECT work{};
    if (::SystemParametersInfo(SPI_GETWORKAREA, 0, &work, 0)) {
      const int scale = ::GetDpiForWindow(desktop) / 96;
      origin = Win32Window::Point(
          work.right - (kWidth * (scale > 0 ? scale : 1)) - 40, 60);
    }
  }

  Win32Window::Size size(kWidth, kHeight);
  if (!window.Create(L"VPN", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
