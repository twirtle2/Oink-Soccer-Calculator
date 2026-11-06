package main

import (
	soccer "github.com/stein-f/oink-soccer-common/v2"
	"reflect"
	"testing"
)

func TestSimDeterministic(t *testing.T) {
	players := make([]soccer.SelectedPlayer, 5)
	positions := []soccer.PlayerPosition{soccer.PlayerPositionGoalkeeper, soccer.PlayerPositionDefense, soccer.PlayerPositionDefense, soccer.PlayerPositionMidfield, soccer.PlayerPositionAttack}
	for i, p := range positions {
		players[i] = soccer.SelectedPlayer{ID: string(rune('a' + i)), SelectedPosition: p, Attributes: soccer.PlayerAttributes{PrimaryPosition: p, Positions: []soccer.PlayerPosition{p}, GoalkeeperRating: 75, DefenseRating: 75, ControlRating: 75, AttackRating: 75, SpeedRating: 75}}
	}
	team := soccer.GameLineup{Team: soccer.Team{Formation: soccer.FormationTypePyramid}, Players: players}
	req := request{Home: team, Away: team, MyHome: true, Trials: 100, Seed: 1, Scenarios: []scenario{{Key: "base"}, {Key: "gold", Boosts: []soccer.Boost{{BoostType: soccer.BoostTypeTeam, MinBoost: 1.05, MaxBoost: 1.05}}}}}
	a, err := runSim(req)
	if err != nil {
		t.Fatal(err)
	}
	b, err := runSim(req)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) || a[0].Wins+a[0].Draws+a[0].Losses != 100 {
		t.Fatal("inconsistent results", a, b)
	}
	if len(a) != 2 || a[1].Key != "gold" {
		t.Fatal("boost scenario missing", a)
	}
}
