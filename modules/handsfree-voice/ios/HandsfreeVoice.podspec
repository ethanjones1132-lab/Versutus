Pod::Spec.new do |s|
  s.name           = 'HandsfreeVoice'
  s.version        = '1.0.0'
  s.summary        = 'Hands-free background voice chat for Versutus'
  s.description    = 'A local Expo module that owns the native microphone, audio session and foreground service for a user-started hands-free call.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "Tests/**/*"
  # The bundled send earcon: a short, pre-recorded non-verbal sound played
  # through the call's own audio session. It is a module resource, not an npm
  # audio dependency (the constraints exclude expo-audio).
  s.resources = "Resources/**/*"

  # A podspec cannot add a target to the app project; `test_spec` is the
  # CocoaPods mechanism for module-owned tests, so the endpointing XCTest
  # bundle builds with the pod rather than with the app.
  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = 'Tests/**/*.{swift,h,m}'
  end
end
