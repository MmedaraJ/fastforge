package jobs

// When your API calls InsertTx with a TranscodeArgs{AssetID: "abc"},
// River can't store a Go struct in Postgres —
// it stores JSON ({"asset_id":"abc"}) in the row's args column,
// plus kind = "transcode"

// Model the transoding instruction given to river
type TranscodeArgs struct {
	AssetID string `json:"asset_id"`
}

// What string do I write in the kind column of river_job,
// and which worker do I hand this row to when I read it back?
func (args TranscodeArgs) Kind() string {
	return "transcode"
}
