import 'app.dart';
import 'core/flavour.dart';

Future<void> main() => bootstrap(
      const FlavourConfig(
        flavour: AppFlavour.doctor,
        appName: 'MediCore Doctor',
        apiBaseUrl:
            String.fromEnvironment('API_BASE_URL', defaultValue: 'https://DOMAIN_PLACEHOLDER/api'),
        wsBaseUrl:
            String.fromEnvironment('WS_BASE_URL', defaultValue: 'wss://DOMAIN_PLACEHOLDER/ws'),
      ),
    );
