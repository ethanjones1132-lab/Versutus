import ExpoModulesCore
import UIKit

/**
 Cleans up a running hands-free call if the process is terminating. The module
 itself also tears down on `OnDestroy`; this subscriber is the belt-and-braces
 for a termination that does not run the module lifecycle, so the microphone
 and audio session are released rather than left to the OS.
 */
public class HandsfreeVoiceAppDelegateSubscriber: BaseExpoAppDelegateSubscriber, ExpoAppDelegateSubscriberProtocol {
  public func applicationWillTerminate(_ application: UIApplication) {
    HandsfreeVoiceModule.current?.teardown(reason: "app-killed")
  }
}
