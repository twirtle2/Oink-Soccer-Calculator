package main

import (
	"fmt"
	soccer "github.com/stein-f/oink-soccer-common/v2"
	"math/rand"
)

type request struct {
	Home      soccer.GameLineup `json:"home"`
	Away      soccer.GameLineup `json:"away"`
	MyHome    bool              `json:"myHome"`
	Trials    int               `json:"trials"`
	Seed      int64             `json:"seed"`
	Scenarios []scenario        `json:"scenarios"`
}
type scenario struct {
	Key    string         `json:"key"`
	Boosts []soccer.Boost `json:"boosts"`
}
type result struct {
	Key          string `json:"key"`
	Wins         int    `json:"wins"`
	Draws        int    `json:"draws"`
	Losses       int    `json:"losses"`
	GoalsFor     int    `json:"goalsFor"`
	GoalsAgainst int    `json:"goalsAgainst"`
	Trials       int    `json:"trials"`
}

func runSim(r request) ([]result, error) {
	if len(r.Home.Players) != 5 || len(r.Away.Players) != 5 {
		return nil, fmt.Errorf("two complete five-player lineups are required")
	}
	if r.Trials < 1 || r.Trials > 20000 {
		return nil, fmt.Errorf("invalid simulation count")
	}
	if len(r.Scenarios) < 1 || len(r.Scenarios) > 10 {
		return nil, fmt.Errorf("invalid scenario count")
	}
	out := make([]result, 0, len(r.Scenarios))
	for _, sc := range r.Scenarios {
		home, away := r.Home, r.Away
		if r.MyHome {
			home.ItemBoosts = sc.Boosts
		} else {
			away.ItemBoosts = sc.Boosts
		}
		res := result{Key: sc.Key, Trials: r.Trials}
		for i := 0; i < r.Trials; i++ {
			events, _, err := soccer.RunGameWithSeed(rand.New(rand.NewSource(r.Seed+int64(i))), home, away)
			if err != nil {
				return nil, err
			}
			stats := soccer.CreateGameStats(events)
			mine, other := stats.AwayTeamStats.Goals, stats.HomeTeamStats.Goals
			if r.MyHome {
				mine, other = other, mine
			}
			res.GoalsFor += mine
			res.GoalsAgainst += other
			if mine > other {
				res.Wins++
			} else if mine == other {
				res.Draws++
			} else {
				res.Losses++
			}
		}
		out = append(out, res)
	}
	return out, nil
}
