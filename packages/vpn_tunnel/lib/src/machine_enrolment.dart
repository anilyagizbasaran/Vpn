/// The credential a machine enrolled with, as far as an app may see it.
///
/// Deliberately not a keypair. On desktop the WireGuard private key lives in
/// the daemon and stays there; what an app needs to read its own device from
/// the API is the token, and handing it anything more would put key material
/// in a GUI process for no benefit.
class MachineIdentity {
  const MachineIdentity({required this.controlPlane, required this.deviceToken});

  /// The control plane this machine enrolled against, so the app talks to the
  /// same server the tunnel does rather than whatever it was last configured
  /// with.
  final String controlPlane;

  final String deviceToken;
}

/// Something that can enrol this whole machine, once, on the app's behalf.
///
/// This exists so a computer is one device instead of two. Before it, the
/// desktop app enrolled in Dart and the browser extension enrolled through the
/// daemon: same machine, two keypairs, two rows on the server, and an invite
/// code the user had to type twice. Whoever set it up first now owns the
/// identity and the other adopts it.
///
/// Null on platforms where the app is the only client — mobile has no daemon
/// and no second consumer to share with.
abstract interface class MachineEnrolment {
  /// The credential this machine already holds, or null if it has none.
  ///
  /// Never throws for "not set up yet": that is an answer, not a failure.
  Future<MachineIdentity?> identity();

  /// Enrols this machine and returns the credential it got.
  ///
  /// Throws [TunnelException] with a message fit to show the user.
  Future<MachineIdentity> enrol({
    required String serverAddress,
    required String inviteToken,
  });

  /// Erases this machine's identity and stops the tunnel.
  ///
  /// Called when the user removes the device. Without it the daemon keeps a
  /// credential the server has already deleted and reconnects into a 401 that
  /// looks, from the outside, like the VPN is simply broken.
  ///
  /// Succeeds when there was nothing to erase.
  Future<void> forget();
}
