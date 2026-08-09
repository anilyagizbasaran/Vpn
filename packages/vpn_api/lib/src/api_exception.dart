/// An error the API returned, or a transport failure while talking to it.
///
/// [code] mirrors the backend's `error.code` so the UI can react to specific
/// cases (device quota, expired session) instead of matching on message text.
class ApiException implements Exception {
  const ApiException({
    required this.message,
    this.code = 'unknown',
    this.statusCode,
    this.details,
  });

  final String message;
  final String code;
  final int? statusCode;
  final Object? details;

  factory ApiException.network(Object error) => ApiException(
    message:
        'Cannot reach the VPN service. Check your internet connection and try again.',
    code: 'network_error',
    details: error,
  );

  factory ApiException.timeout() => const ApiException(
    message: 'The VPN service took too long to respond. Try again.',
    code: 'timeout',
  );

  bool get isSessionExpired => statusCode == 401 || code == 'unauthorized';

  bool get isQuotaExceeded => code == 'peer_quota_exceeded';

  /// A step-up check failed (wrong password on a sensitive action). Distinct
  /// from [isSessionExpired] on purpose: the server answers 403 here so the
  /// client does not mistake a typo for a dead token and sign the user out.
  bool get isInvalidPassword => code == 'invalid_password';

  @override
  String toString() => 'ApiException($code): $message';
}
