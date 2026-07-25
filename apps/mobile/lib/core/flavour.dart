/// The three shipped apps share one codebase and differ only by flavour.
enum AppFlavour { doctor, nurse, patient }

class FlavourConfig {
  const FlavourConfig({
    required this.flavour,
    required this.appName,
    required this.apiBaseUrl,
    required this.wsBaseUrl,
    this.requireBiometricUnlock = true,
  });

  final AppFlavour flavour;
  final String appName;
  final String apiBaseUrl;
  final String wsBaseUrl;
  final bool requireBiometricUnlock;

  static late FlavourConfig current;

  bool get isDoctor => flavour == AppFlavour.doctor;
  bool get isNurse => flavour == AppFlavour.nurse;
  bool get isPatient => flavour == AppFlavour.patient;

  /// Clinical flavours hold PHI on device and must re-authenticate on resume.
  bool get holdsPhi => flavour != AppFlavour.patient;
}
