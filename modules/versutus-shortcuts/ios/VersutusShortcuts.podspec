Pod::Spec.new do |s|
  s.name           = 'VersutusShortcuts'
  s.version        = '1.0.0'
  s.summary        = 'Per-Bot app shortcut donation for Versutus'
  s.description    = 'A local Expo module that donates recent Bot shortcuts.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "Tests/**/*"
end
