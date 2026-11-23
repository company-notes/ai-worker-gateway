export class ModelSelectionPolicy {
    static validate(value) {
        const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
        if (!isObject || Object.keys(value).some((key) => !['instanceId', 'model', 'options'].includes(key)) ||
            typeof value.instanceId !== 'string' || !value.instanceId.trim() ||
            typeof value.model !== 'string' || !value.model.trim()) {
            throw new Error('Model selection needs an instanceId and model from the Fleet model catalog');
        }

        if (value.options !== undefined) {
            const optionsValid = value.options !== null && typeof value.options === 'object' &&
                !Array.isArray(value.options) && Object.entries(value.options).every(([key, selected]) =>
                    key.length > 0 && (typeof selected === 'boolean' ||
                        (typeof selected === 'string' && selected.length > 0)));
            if (!optionsValid) {
                throw new Error('Model selection options must contain only nonempty strings or booleans');
            }
        }

        if (JSON.stringify(value).length > 4096) {
            throw new Error('Model selection exceeds the allowed size');
        }

        return value;
    }

    static fromJSON(value) {
        if (value.length > 4096) {
            throw new Error('AWG_PROVISION_MODEL_SELECTION is too long');
        }

        let selection;
        try {
            selection = JSON.parse(value);
        } catch {
            throw new Error('AWG_PROVISION_MODEL_SELECTION must be valid JSON');
        }

        return ModelSelectionPolicy.validate(selection);
    }
}
