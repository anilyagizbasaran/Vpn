import 'package:flutter/material.dart';

/// The app's palette, written out rather than seeded.
///
/// `ColorScheme.fromSeed` is the right default for an app with many surfaces
/// and states. This one has three: connected, not connected, and something
/// went wrong. Naming those directly is shorter than deriving them and it
/// keeps the connected green from drifting every time the seed is touched.
abstract final class VpnColors {
  /// Connected. Deliberately not the accent — the accent invites a click, and
  /// once you are connected there is nothing you need to do.
  static const connected = Color(0xFF12B76A);

  /// The one thing to press when nothing is happening.
  static const accent = Color(0xFF2F6BFF);

  static const danger = Color(0xFFF04438);

  static const darkBackground = Color(0xFF0F1216);
  static const darkSurface = Color(0xFF171B21);
  static const darkBorder = Color(0xFF262C35);
  static const darkText = Color(0xFFE8EBEF);
  static const darkMuted = Color(0xFF8A929E);

  static const lightBackground = Color(0xFFF7F8FA);
  static const lightSurface = Color(0xFFFFFFFF);
  static const lightBorder = Color(0xFFE3E6EA);
  static const lightText = Color(0xFF14161A);
  static const lightMuted = Color(0xFF5C626B);
}

ThemeData buildTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;

  final background = dark
      ? VpnColors.darkBackground
      : VpnColors.lightBackground;
  final surface = dark ? VpnColors.darkSurface : VpnColors.lightSurface;
  final border = dark ? VpnColors.darkBorder : VpnColors.lightBorder;
  final text = dark ? VpnColors.darkText : VpnColors.lightText;
  final muted = dark ? VpnColors.darkMuted : VpnColors.lightMuted;

  final scheme =
      ColorScheme.fromSeed(
        seedColor: VpnColors.accent,
        brightness: brightness,
      ).copyWith(
        surface: background,
        onSurface: text,
        onSurfaceVariant: muted,
        outlineVariant: border,
        error: VpnColors.danger,
      );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: background,
    // The window is 380 wide. Material's defaults are tuned for a phone held
    // at arm's length; at this size they leave no room for anything else.
    visualDensity: VisualDensity.compact,
    appBarTheme: AppBarTheme(
      backgroundColor: background,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: text,
        fontSize: 15,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.2,
      ),
      iconTheme: IconThemeData(color: muted, size: 20),
    ),
    cardTheme: CardThemeData(
      color: surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: border),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: surface,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: VpnColors.accent, width: 1.5),
      ),
      labelStyle: TextStyle(color: muted, fontSize: 13),
      hintStyle: TextStyle(color: muted.withValues(alpha: 0.6), fontSize: 13),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: VpnColors.accent,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(46),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: VpnColors.accent),
    ),
    dividerTheme: DividerThemeData(color: border, space: 1, thickness: 1),
  );
}
