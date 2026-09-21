interface AuthSession {
    access_token: string;
    refresh_token: string | null;
    device_id?: string;
}
export declare class DeviceAuthenticator {
    private baseServerUrl;
    constructor(baseServerUrl: string);
    authenticate(deviceId?: string): Promise<AuthSession>;
    private generatePKCE;
    private requestDeviceCode;
    private displayUserInstructions;
    private pollForAuthorization;
    private sleep;
}
export {};
