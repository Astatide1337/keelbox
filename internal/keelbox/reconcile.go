package keelbox

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Reconcile only the recorded inventory. Desired application writes are accepted
// first, so a failed apply never starts removal of the previous application.
func (e *environment) reconcileResources(ctx context.Context, desired []object) (err error) {
	defer func() {
		if ctx.Err() != nil {
			err = errors.Join(err, ctx.Err())
		}
	}()
	wanted := map[string]bool{}
	for _, o := range desired {
		r, err := objectResource(o)
		if err != nil {
			return err
		}
		wanted[r.Kind+"/"+r.Name] = true
	}
	obsolete := []resourceRef{}
	for _, r := range e.state.Resources {
		if !wanted[r.Kind+"/"+r.Name] {
			obsolete = append(obsolete, r)
		}
	}
	// Preflight the entire removal set before any destructive change.
	for _, r := range obsolete {
		actual, err := e.observe(ctx, r)
		if err != nil {
			return err
		}
		if actual != nil {
			if err = e.verifyRecordedResource(actual, r); err != nil {
				return err
			}
			if r.Kind == "StatefulSet" {
				if err = safeStatefulRetention(actual); err != nil {
					return err
				}
			}
		}
		action := "remove"
		if retainedResource(r) {
			action = "retain"
		}
		if r.Kind == "StatefulSet" {
			action = "retain at zero replicas"
		}
		fmt.Printf("Obsolete %s/%s: %s\n", r.Kind, r.Name, action)
	}
	for _, r := range obsolete {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := e.reconcileObsolete(ctx, r); err != nil {
			return err
		}
	}
	return nil
}

func retainedResource(r resourceRef) bool {
	return r.Kind == "Namespace" || r.Kind == "PersistentVolumeClaim" || r.Kind == "StatefulSet"
}

func (e *environment) verifyRecordedResource(actual map[string]any, r resourceRef) error {
	uid, err := objectUID(actual)
	if err != nil {
		return err
	}
	if uid != r.UID || r.UID == "" {
		return fmt.Errorf("%s/%s was replaced; refusing reconciliation", r.Kind, r.Name)
	}
	return e.checkResourceOwnership(actual, r)
}

func safeStatefulRetention(actual map[string]any) error {
	spec, ok := actual["spec"].(map[string]any)
	if !ok {
		return fmt.Errorf("retained StatefulSet has no valid spec")
	}
	if spec["persistentVolumeClaimRetentionPolicy"] == nil {
		return nil
	}
	policy, ok := spec["persistentVolumeClaimRetentionPolicy"].(map[string]any)
	if !ok {
		return fmt.Errorf("invalid StatefulSet PVC retention policy")
	}
	// Scaling down must not authorize Kubernetes to remove development data.
	if value, exists := policy["whenScaled"]; exists && value != "Retain" {
		return fmt.Errorf("StatefulSet whenScaled must be Retain before scaling down; refusing data deletion")
	}
	return nil
}

func (e *environment) reconcileObsolete(ctx context.Context, r resourceRef) error {
	// Repeat observation immediately before the mutation; DELETE/PATCH also carry
	// UID preconditions so replacements cannot be deleted in the intervening race.
	actual, err := e.observe(ctx, r)
	if err != nil {
		return err
	}
	if actual != nil {
		if err = e.verifyRecordedResource(actual, r); err != nil {
			return err
		}
		if r.Kind == "StatefulSet" {
			if err = safeStatefulRetention(actual); err != nil {
				return err
			}
			if err = e.stopRetainedStatefulSet(ctx, r); err != nil {
				return err
			}
		} else if !retainedResource(r) {
			if err = e.deleteOwned(ctx, r); err != nil {
				return err
			}
		}
	}
	if actual == nil || !retainedResource(r) {
		for i, recorded := range e.state.Resources {
			if recorded == r {
				e.state.Resources = append(e.state.Resources[:i], e.state.Resources[i+1:]...)
				break
			}
		}
		// Save each accepted deletion separately. A later failure must not forget
		// resources still awaiting deletion, including after interruption.
		return e.save()
	}
	return nil
}

func (e *environment) stopRetainedStatefulSet(ctx context.Context, r resourceRef) error {
	actual, err := e.observe(ctx, r)
	if err != nil {
		return err
	}
	if actual == nil {
		return fmt.Errorf("retained StatefulSet disappeared")
	}
	if err = e.verifyRecordedResource(actual, r); err != nil {
		return err
	}
	if err = safeStatefulRetention(actual); err != nil {
		return err
	}
	meta, err := objectMetadata(actual)
	if err != nil {
		return err
	}
	version, ok := meta["resourceVersion"].(string)
	if !ok || version == "" {
		return fmt.Errorf("retained StatefulSet has no resourceVersion; refusing unsafe scale down")
	}
	if err = e.setReplicas(ctx, r, 0, version); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	for {
		actual, err := e.observe(ctx, r)
		if err != nil {
			return err
		}
		if actual == nil {
			return fmt.Errorf("retained StatefulSet disappeared")
		}
		if err = e.verifyRecordedResource(actual, r); err != nil {
			return err
		}
		replicas, err := observedReplicas(actual)
		if err != nil {
			return err
		}
		if replicas == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}
