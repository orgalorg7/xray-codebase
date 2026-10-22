<?php

use App\Repos\UserRepo;
use PHPUnit\Framework\TestCase;

class UserRepoTest extends TestCase
{
    public function testFind(): void { (new UserRepo())->find('a'); }
}
