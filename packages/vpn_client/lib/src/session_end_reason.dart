/// Why a session is ending. The three cases need genuinely different cleanup,
/// and collapsing them into a boolean is how device keys get orphaned.
enum SessionEndReason {
  /// The user signed out. The peer is revoked server-side and the device key
  /// is wiped — it is about to become unrecoverable anyway, so leaving the
  /// peer registered would burn a device slot forever.
  signedOut,

  /// The account was deleted. The server already removed every peer, so there
  /// is nothing to revoke, but the local key is now useless and must go.
  accountDeleted,

  /// The refresh token was rejected. The access token is already dead so a
  /// revoke would fail — and the device key is kept on purpose, so signing
  /// back in reuses the same peer instead of consuming another slot.
  sessionExpired,
}

extension SessionEndReasonBehaviour on SessionEndReason {
  bool get revokesPeerOnServer => this == SessionEndReason.signedOut;

  bool get wipesStoredDevice => this != SessionEndReason.sessionExpired;
}
