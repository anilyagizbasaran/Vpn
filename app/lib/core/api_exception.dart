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

  bool get isSessionExpired =>
      statusCode == 401 || code == 'unauthorized';

  bool get isQuotaExceeded => code == 'peer_quota_exceeded';

  @override
  String toString() => 'ApiException($code): $message';
}
