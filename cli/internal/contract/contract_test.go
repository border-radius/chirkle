package contract

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// The copy here must match shared/contract.json, as the web's and the app's copies do (docs/API.md).
func TestMatchesShared(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Fields map[string]string `json:"fields"`
		Limits map[string]any    `json:"limits"`
		Files  map[string][]string
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string]string{"message": Fields.Message, "room": Fields.Room, "user": Fields.User, "roomRow": Fields.RoomRow} {
		if c.Fields[name] != got {
			t.Errorf("fields.%s differs from shared/contract.json:\n got %s\nwant %s", name, got, c.Fields[name])
		}
	}
	ints := map[string]int{
		"messageText": Limits.MessageText, "userName": Limits.UserName, "roomName": Limits.RoomName,
		"passwordMin": Limits.PasswordMin, "passwordMaxBytes": Limits.PasswordMaxBytes, "attachments": Limits.Attachments,
		"attachmentBytes": Limits.AttachmentBytes, "maxSelected": Limits.MaxSelected,
	}
	for name, got := range ints {
		if want, ok := c.Limits[name].(float64); !ok || int(want) != got {
			t.Errorf("limits.%s = %d, shared/contract.json has %v", name, got, c.Limits[name])
		}
	}
	for name, got := range map[string][]string{"image": Files.Image, "video": Files.Video, "audio": Files.Audio} {
		if !reflect.DeepEqual(c.Files[name], got) {
			t.Errorf("files.%s = %v, shared/contract.json has %v", name, got, c.Files[name])
		}
	}
}
