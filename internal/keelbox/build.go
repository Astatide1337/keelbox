package keelbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/moby/patternmatcher"
	"github.com/moby/patternmatcher/ignorefile"
)

func buildFingerprint(b buildSpec) (string, error) {
	ignorePath, patterns, err := readBuildIgnores(b)
	if err != nil {
		return "", err
	}
	matcher, err := patternmatcher.New(patterns)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err = fmt.Fprintf(h, "%s\x00%s\x00%s\x00", b.Dockerfile, b.Target, b.Image); err != nil {
		return "", err
	}
	err = filepath.WalkDir(b.Context, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, relativeErr := filepath.Rel(b.Context, path)
		if relativeErr != nil {
			return relativeErr
		}
		if rel == "." {
			return nil
		}
		excluded, matchErr := matcher.MatchesOrParentMatches(filepath.ToSlash(rel))
		if matchErr != nil {
			return matchErr
		}
		if excluded && rel != b.Dockerfile && path != ignorePath {
			if d.IsDir() && !matcher.Exclusions() {
				return filepath.SkipDir
			}
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return infoErr
		}
		if _, writeErr := fmt.Fprintf(h, "%s\x00%d\x00", filepath.ToSlash(rel), info.Mode()); writeErr != nil {
			return writeErr
		}
		if d.Type()&os.ModeSymlink != 0 {
			target, linkErr := os.Readlink(path)
			if linkErr != nil {
				return linkErr
			}
			_, writeErr := io.WriteString(h, target)
			return writeErr
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		f, openErr := os.Open(path)
		if openErr != nil {
			return openErr
		}
		_, copyErr := io.Copy(h, f)
		return errors.Join(copyErr, f.Close())
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (e *environment) build(ctx context.Context, only string) error {
	current, err := localDocker(ctx)
	if err != nil {
		return err
	}
	if e.state.DockerContext != "" && e.state.DockerContext != current {
		return fmt.Errorf("docker context changed from %s", e.state.DockerContext)
	}
	e.state.DockerContext = current
	if e.state.Artifacts == nil {
		e.state.Artifacts = map[string]imageArtifact{}
	}
	for _, image := range e.state.Images {
		e.state.Artifacts[image.Tag] = image
	}
	found := false
	for _, b := range e.config.Build {
		if only != "" && b.Name != only {
			continue
		}
		found = true
		if buildErr := e.buildImage(ctx, current, b); buildErr != nil {
			return buildErr
		}
	}
	if !found {
		return fmt.Errorf("unknown image %q", only)
	}
	return nil
}

func readBuildIgnores(b buildSpec) (string, []string, error) {
	ignorePath := filepath.Join(b.Context, b.Dockerfile+".dockerignore")
	if _, statErr := os.Stat(ignorePath); os.IsNotExist(statErr) {
		ignorePath = filepath.Join(b.Context, ".dockerignore")
	}
	f, err := os.Open(ignorePath)
	if os.IsNotExist(err) {
		return ignorePath, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	patterns, readErr := ignorefile.ReadAll(f)
	return ignorePath, patterns, errors.Join(readErr, f.Close())
}

func (e *environment) buildImage(ctx context.Context, current string, b buildSpec) error {
	fingerprint, err := buildFingerprint(b)
	if err != nil {
		return err
	}
	tag := b.Image + ":kb-" + fingerprint[:20]
	previous, ok := e.state.Artifacts[tag]
	if ok && previous.Fingerprint == fingerprint {
		actual, inspectErr := capture(ctx, "docker", "--context", current, "image", "inspect", previous.Tag, "--format", "{{.Id}}")
		if inspectErr == nil && trim(actual) == previous.ID {
			e.state.Images[b.Name] = previous
			if err = e.save(); err != nil {
				return err
			}
			fmt.Println("Reusing image:", b.Name)
			return nil
		}
	}
	fmt.Println("Building", b.Name, "→", tag)
	iidPath := filepath.Join(e.dir, "image-id")
	args := []string{"--context", current, "build", "--iidfile", iidPath, "--tag", tag, "--file", filepath.Join(b.Context, b.Dockerfile)}
	if b.Target != "" {
		args = append(args, "--target", b.Target)
	}
	args = append(args, b.Context)
	if err = stream(ctx, "docker", args...); err != nil {
		return fmt.Errorf("image %s build failed: %w", b.Name, err)
	}
	after, err := buildFingerprint(b)
	if err != nil {
		return err
	}
	if after != fingerprint {
		return fmt.Errorf("build inputs changed during %s build; rerun", b.Name)
	}
	id, err := os.ReadFile(iidPath)
	if err != nil {
		return err
	}
	e.state.Images[b.Name] = imageArtifact{Fingerprint: fingerprint, Tag: tag, ID: trim(string(id))}
	e.state.Artifacts[tag] = e.state.Images[b.Name]
	if err = e.save(); err != nil {
		return err
	}
	return nil
}
