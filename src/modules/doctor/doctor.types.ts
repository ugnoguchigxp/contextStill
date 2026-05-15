export type DoctorOptions = {
  windowSize?: number;
  freshnessThresholdMinutes?: number;
  degradedRateThreshold?: number;
};

export type ResolvedDoctorOptions = {
  windowSize: number;
  freshnessThresholdMinutes: number;
  degradedRateThreshold: number;
};
