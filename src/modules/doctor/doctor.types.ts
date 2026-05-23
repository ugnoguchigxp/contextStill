export type DoctorOptions = {
  windowSize?: number;
  freshnessThresholdMinutes?: number;
  degradedRateThreshold?: number;
  strict?: boolean;
};

export type ResolvedDoctorOptions = {
  windowSize: number;
  freshnessThresholdMinutes: number;
  degradedRateThreshold: number;
  strict: boolean;
};
