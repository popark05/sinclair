export const USB_PLATFORM_PACKAGES: Record<string, string>;
export const USB_PACKAGE_DIR: string;
export function ensureUsbPackage(target: string): Promise<string>;
