package keelbox

import "fmt"

// Kubernetes objects are validated where untyped YAML or API JSON enters the workflow.
func objectMetadata(o map[string]any) (map[string]any, error) {
	metadata, ok := o["metadata"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("resource metadata is missing or is not an object")
	}
	return metadata, nil
}

func objectResource(o object) (resourceRef, error) {
	metadata, err := objectMetadata(o)
	if err != nil {
		return resourceRef{}, err
	}
	apiVersion, apiOK := o["apiVersion"].(string)
	kind, kindOK := o["kind"].(string)
	name, nameOK := metadata["name"].(string)
	if !apiOK || !kindOK || !nameOK || apiVersion == "" || kind == "" || name == "" {
		return resourceRef{}, fmt.Errorf("resource needs string apiVersion, kind, and metadata.name")
	}
	return resourceRef{APIVersion: apiVersion, Kind: kind, Name: name}, nil
}

func objectUID(o map[string]any) (string, error) {
	metadata, err := objectMetadata(o)
	if err != nil {
		return "", err
	}
	uid, ok := metadata["uid"].(string)
	if !ok || uid == "" {
		return "", fmt.Errorf("observed resource has no valid UID")
	}
	return uid, nil
}

func metadataValues(metadata map[string]any, field string) (map[string]any, error) {
	if metadata[field] == nil {
		return map[string]any{}, nil
	}
	values, ok := metadata[field].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("resource metadata.%s must be an object of strings", field)
	}
	for _, value := range values {
		if _, valid := value.(string); !valid {
			return nil, fmt.Errorf("resource metadata.%s must contain string values", field)
		}
	}
	return values, nil
}

func observedReplicas(o map[string]any) (float64, error) {
	if o["status"] == nil {
		return 0, nil
	}
	status, ok := o["status"].(map[string]any)
	if !ok {
		return 0, fmt.Errorf("observed resource status is not an object")
	}
	if status["replicas"] == nil {
		return 0, nil
	}
	replicas, ok := status["replicas"].(float64)
	if !ok || replicas < 0 {
		return 0, fmt.Errorf("observed resource replica count is invalid")
	}
	return replicas, nil
}
