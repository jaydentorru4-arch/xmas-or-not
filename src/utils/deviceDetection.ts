import { useEffect, useState } from 'react';

export type ControlScheme = 'auto' | 'mobile' | 'desktop';

export interface DeviceDetectionState {
  isMobileDevice: boolean;
  deviceType: 'mobile' | 'desktop';
  controlScheme: ControlScheme;
  setControlScheme: (scheme: ControlScheme) => void;
  showMobileControls: boolean;
}

const CONTROL_SCHEME_KEY = 'hollow_eve_control_scheme_v1';

export function detectIsMobileDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };

  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') {
    if (nav.userAgentData.mobile) return true;
  }

  const ua = navigator.userAgent || '';
  const mobileUaRegex =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|Silk|Kindle/i;
  if (mobileUaRegex.test(ua)) {
    return true;
  }

  // iPadOS 13+ reports Macintosh in UA but has MacIntel platform + multi-touch
  const isIpadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (isIpadOs) {
    return true;
  }

  const coarsePointer =
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(any-pointer: coarse)').matches);
  const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;

  if (coarsePointer && hasTouch) {
    return true;
  }

  // Compact touch-enabled viewport (covers Android tablets / foldables / Chrome DevTools mobile emulation)
  if (hasTouch && Math.min(window.innerWidth, window.innerHeight) <= 900) {
    return true;
  }

  return false;
}

function loadSavedControlScheme(): ControlScheme {
  try {
    const raw = window.localStorage.getItem(CONTROL_SCHEME_KEY);
    if (raw === 'mobile' || raw === 'desktop' || raw === 'auto') return raw;
  } catch {
    // ignore storage errors
  }
  return 'auto';
}

export function useDeviceDetection(): DeviceDetectionState {
  const [isMobileDevice, setIsMobileDevice] = useState<boolean>(() => detectIsMobileDevice());
  const [controlScheme, setControlSchemeState] = useState<ControlScheme>(() =>
    loadSavedControlScheme()
  );

  const setControlScheme = (scheme: ControlScheme) => {
    setControlSchemeState(scheme);
    try {
      window.localStorage.setItem(CONTROL_SCHEME_KEY, scheme);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const recheck = () => {
      setIsMobileDevice(detectIsMobileDevice());
    };

    const onFirstTouch = () => {
      // If user physically taps screen on a touch-capable / narrow device, treat as mobile
      if (
        detectIsMobileDevice() ||
        (navigator.maxTouchPoints > 0 && window.innerWidth <= 1180)
      ) {
        setIsMobileDevice(true);
      }
    };

    window.addEventListener('resize', recheck);
    window.addEventListener('orientationchange', recheck);
    window.addEventListener('touchstart', onFirstTouch, { passive: true });

    const coarseMql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(pointer: coarse)')
        : null;
    coarseMql?.addEventListener?.('change', recheck);

    return () => {
      window.removeEventListener('resize', recheck);
      window.removeEventListener('orientationchange', recheck);
      window.removeEventListener('touchstart', onFirstTouch);
      coarseMql?.removeEventListener?.('change', recheck);
    };
  }, []);

  const showMobileControls =
    controlScheme === 'mobile'
      ? true
      : controlScheme === 'desktop'
        ? false
        : isMobileDevice;

  return {
    isMobileDevice,
    deviceType: isMobileDevice ? 'mobile' : 'desktop',
    controlScheme,
    setControlScheme,
    showMobileControls,
  };
}
