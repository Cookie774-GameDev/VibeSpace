//! Conservative planning floors for a prepared runtime, scaled by model size.
//! Real device calibration still verifies the chosen batch/sequence settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct WeightTrainingRequirements {
    pub(crate) vram_gb: f64,
    pub(crate) ram_gb: f64,
    pub(crate) storage_gb: f64,
}

pub(crate) fn weight_training_requirements(
    method: &str,
    parameters_b: f64,
) -> WeightTrainingRequirements {
    let parameters_b = parameters_b.max(0.1);
    match method {
        "qlora" => WeightTrainingRequirements {
            vram_gb: (parameters_b * 4.0).max(2.0).ceil(),
            ram_gb: (parameters_b * 12.0).max(4.0).ceil(),
            storage_gb: (parameters_b * 8.0).max(2.0).ceil(),
        },
        "lora" => WeightTrainingRequirements {
            vram_gb: (parameters_b * 8.0).max(2.0).ceil(),
            ram_gb: (parameters_b * 16.0).max(4.0).ceil(),
            storage_gb: (parameters_b * 12.0).max(2.0).ceil(),
        },
        _ => WeightTrainingRequirements {
            vram_gb: (parameters_b * 16.0).max(4.0).ceil(),
            ram_gb: (parameters_b * 32.0).max(8.0).ceil(),
            storage_gb: (parameters_b * 40.0).max(4.0).ceil(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn small_adapter_fits_modest_accelerators_without_larger_model_floor() {
        let tiny = weight_training_requirements("lora", 0.135);
        assert!(tiny.vram_gb <= 6.0);
        assert!(tiny.ram_gb <= 4.0);
        assert!(tiny.storage_gb <= 2.0);
        assert!(weight_training_requirements("lora", 1.0).vram_gb > 6.0);
    }
    #[test]
    fn full_training_and_large_quantized_models_remain_conservative() {
        assert!(weight_training_requirements("full", 0.135).vram_gb >= 4.0);
        assert!(weight_training_requirements("full", 7.0).storage_gb >= 280.0);
        assert!(weight_training_requirements("qlora", 7.0).vram_gb >= 28.0);
    }
}
