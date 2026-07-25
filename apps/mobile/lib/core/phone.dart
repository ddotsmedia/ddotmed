/// E.164 phone handling for the international deployments MediCore supports.
library;

class CountryDialCode {
  const CountryDialCode(this.iso, this.dial, this.nationalLength);

  final String iso;
  final String dial;

  /// Expected national significant number length, used for input validation.
  final int nationalLength;
}

const supportedDialCodes = <CountryDialCode>[
  CountryDialCode('AE', '971', 9),
  CountryDialCode('SA', '966', 9),
  CountryDialCode('IN', '91', 10),
  CountryDialCode('US', '1', 10),
  CountryDialCode('GB', '44', 10),
  CountryDialCode('FR', '33', 9),
  CountryDialCode('ES', '34', 9),
  CountryDialCode('DE', '49', 10),
  CountryDialCode('KE', '254', 9),
  CountryDialCode('NG', '234', 10),
  CountryDialCode('ZA', '27', 9),
  CountryDialCode('CN', '86', 11),
];

class PhoneResult {
  const PhoneResult({required this.valid, this.e164, this.error});

  final bool valid;
  final String? e164;
  final String? error;
}

/// Normalises a local number plus a country to E.164.
/// A leading national trunk zero is stripped, which is the commonest input error.
PhoneResult toE164(String input, String isoCountry) {
  final country = supportedDialCodes.where((c) => c.iso == isoCountry).firstOrNull;
  if (country == null) {
    return PhoneResult(valid: false, error: 'Unsupported country $isoCountry');
  }

  var digits = input.replaceAll(RegExp(r'[^\d+]'), '');

  if (digits.startsWith('+')) {
    final withoutPlus = digits.substring(1);
    if (!withoutPlus.startsWith(country.dial)) {
      return PhoneResult(valid: false, error: 'Number does not belong to $isoCountry');
    }
    digits = withoutPlus.substring(country.dial.length);
  } else if (digits.startsWith('00${country.dial}')) {
    digits = digits.substring(2 + country.dial.length);
  } else if (digits.startsWith(country.dial) && digits.length > country.nationalLength) {
    digits = digits.substring(country.dial.length);
  }

  digits = digits.replaceFirst(RegExp(r'^0+'), '');

  if (digits.length != country.nationalLength) {
    return PhoneResult(
      valid: false,
      error: 'Expected ${country.nationalLength} digits for $isoCountry, got ${digits.length}',
    );
  }

  return PhoneResult(valid: true, e164: '+${country.dial}$digits');
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
